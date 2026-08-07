// Faithful TypeScript port of kyle-agent-skills select_routing_pair.py
// `select_pair()`, pinned to blob a3a3be6ae276ff636f2cb22cca207985a124fd46
// (commit f9a488bc0a4c86ee506f60b4b5e7b903b617f551). The product recomputes
// the routing selection in-process so a dispatch receipt binds a product-
// verified pair rather than a caller-provided claim (gate_c38ff35fbc0a).
// Behaviour must match the Python exactly; divergence is a security defect.

import { createHash } from 'node:crypto'
import type {
  RoutingModelConfig,
  RoutingProviderConfig,
  RoutingProvidersConfig
} from './routing-bundle'
import { quotaHealth, parseQuotaResponse } from './routing-quota'
import type { QuotaMetrics } from './routing-quota'

export { emptyQuotaResponse, parseQuotaResponse } from './routing-quota'
export type { QuotaMetrics, QuotaReport, QuotaResponse } from './routing-quota'

export const ROUTING_SELECTOR_PIN = {
  repo: 'kyle-agent-skills',
  repoCommitSha: 'f9a488bc0a4c86ee506f60b4b5e7b903b617f551',
  blobSha: 'a3a3be6ae276ff636f2cb22cca207985a124fd46',
  relativePath: 'skills/orca-conductor/scripts/select_routing_pair.py'
} as const

export type RoutingTaskSize = 'light' | 'heavy'

const TASK_COSTS: Record<RoutingTaskSize, readonly [number, number]> = {
  light: [2.0, 1.0],
  heavy: [5.0, 3.0]
}

export type RoutedModel = {
  readonly provider: string
  readonly family: string
  readonly model: string
  readonly effort: string
  readonly command: string
}

export type RankedPair = {
  readonly developer: RoutedModel
  readonly reviewer: RoutedModel
  readonly score: number
  readonly lastResort: boolean
  readonly sameFamily: boolean
  readonly reasons: readonly string[]
}

export type RoutingDecision = {
  readonly developer: RoutedModel
  readonly reviewer: RoutedModel
  readonly score: number
  readonly lastResort: boolean
  readonly sameFamily: boolean
  readonly reasons: readonly string[]
  readonly rankedPairs: readonly RankedPair[]
}

export type SelectionRequest = {
  readonly config: RoutingProvidersConfig
  readonly quotaJson: string
  readonly taskSize: RoutingTaskSize
  readonly unavailableProviders: ReadonlySet<string>
  readonly nowMs: number
  readonly experimentKey: string | null
}

export class RoutingError extends Error {}

function routedModel(provider: RoutingProviderConfig, model: RoutingModelConfig): RoutedModel {
  return {
    provider: provider.id,
    family: provider.family,
    model: model.id,
    effort: model.effort,
    command: model.command
  }
}

function experimentBucket(model: RoutingModelConfig, experimentKey: string): number {
  const digest = createHash('sha256')
    .update(`${model.id}\0${model.effort}\0${experimentKey}`, 'utf8')
    .digest()
  return Number(BigInt(`0x${digest.subarray(0, 8).toString('hex')}`) % 100n)
}

// Returns the experiment reasons tuple, or null when the model is excluded
// from the experiment bucket (must be skipped entirely).
function experimentReasons(
  model: RoutingModelConfig,
  experimentKey: string | null,
  prefix = ''
): string[] | null {
  if (!model.experimental) {
    return []
  }
  if (experimentKey === null) {
    return null
  }
  const bucket = experimentBucket(model, experimentKey)
  if (bucket >= model.experimentSharePercent) {
    return null
  }
  return [
    `${prefix}experiment_bucket=${bucket}`,
    `${prefix}experiment_share=${model.experimentSharePercent}`
  ]
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

export function selectPair(request: SelectionRequest): RoutingDecision {
  const quotas = new Map<string, QuotaMetrics | null>()
  const quotaResponse = parseQuotaResponse(request.quotaJson, (m) => new RoutingError(m))
  for (const report of quotaResponse.reports) {
    quotas.set(report.provider, report.quota)
  }
  const [devCost, reviewCost] = TASK_COSTS[request.taskSize]
  const pairs: RankedPair[] = []
  const providers = request.config.providers.filter((p) => p.enabled)

  for (const devProvider of providers) {
    if (request.unavailableProviders.has(devProvider.id)) {
      continue
    }
    for (const devModel of devProvider.models) {
      if (devModel.role !== 'developer' || !devModel.enabled) {
        continue
      }
      const devExperimentReasons = experimentReasons(devModel, request.experimentKey)
      if (devExperimentReasons === null) {
        continue
      }
      for (const reviewProvider of providers) {
        if (request.unavailableProviders.has(reviewProvider.id)) {
          continue
        }
        if (
          devModel.reviewerFamilyAllowlist.length > 0 &&
          !devModel.reviewerFamilyAllowlist.includes(reviewProvider.family)
        ) {
          continue
        }
        for (const reviewModel of reviewProvider.models) {
          if (reviewModel.role !== 'reviewer' || !reviewModel.enabled) {
            continue
          }
          if (devModel.id === reviewModel.id) {
            continue
          }
          const reviewExperimentReasons = experimentReasons(
            reviewModel,
            request.experimentKey,
            'reviewer_'
          )
          if (reviewExperimentReasons === null) {
            continue
          }
          const costs = new Map<string, number>([
            [devProvider.id, devCost],
            [reviewProvider.id, reviewCost]
          ])
          if (devProvider.id === reviewProvider.id) {
            costs.set(devProvider.id, devCost + reviewCost)
          }
          const devHealth = quotaHealth(
            devProvider,
            costs.get(devProvider.id) as number,
            quotas.get(devProvider.quotaKey ?? '') ?? null,
            request.nowMs
          )
          const reviewHealth = quotaHealth(
            reviewProvider,
            costs.get(reviewProvider.id) as number,
            quotas.get(reviewProvider.quotaKey ?? '') ?? null,
            request.nowMs
          )
          if (!devHealth.available || !reviewHealth.available) {
            continue
          }
          const sameFamily = devProvider.family === reviewProvider.family
          const diversityScore = sameFamily ? -35 : 20
          const score =
            devModel.quality +
            reviewModel.quality +
            devHealth.score +
            reviewHealth.score +
            diversityScore
          const reasons = [
            ...devExperimentReasons,
            ...reviewExperimentReasons,
            ...(devModel.lastResortOnly ? ['developer_model_last_resort'] : []),
            ...(reviewModel.lastResortOnly ? ['reviewer_model_last_resort'] : []),
            ...devHealth.reasons,
            ...reviewHealth.reasons
          ]
          pairs.push({
            developer: routedModel(devProvider, devModel),
            reviewer: routedModel(reviewProvider, reviewModel),
            score: round2(score),
            lastResort:
              devHealth.lastResort ||
              reviewHealth.lastResort ||
              devModel.lastResortOnly ||
              reviewModel.lastResortOnly,
            sameFamily,
            reasons: Object.freeze(reasons)
          })
        }
      }
    }
  }

  if (pairs.length === 0) {
    throw new RoutingError('No runnable developer/reviewer pair remains')
  }
  // Python: sorted(pairs, key=lambda pair: (pair.last_resort, -pair.score))
  const ranked = [...pairs].sort((a, b) => {
    if (a.lastResort !== b.lastResort) {
      return a.lastResort ? 1 : -1
    }
    return b.score - a.score
  })
  const selected = ranked[0]
  return {
    developer: selected.developer,
    reviewer: selected.reviewer,
    score: selected.score,
    lastResort: selected.lastResort,
    sameFamily: selected.sameFamily,
    reasons: selected.reasons,
    rankedPairs: Object.freeze(ranked)
  }
}
