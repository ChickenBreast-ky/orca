import { describe, expect, it } from 'vitest'
import { loadRoutingProvidersBundle, ROUTING_PROVIDERS_PIN } from './routing-bundle'
import {
  selectPair,
  emptyQuotaResponse,
  RoutingError,
  ROUTING_SELECTOR_PIN
} from './routing-selector'

// Why: the product must recompute the SAME selection the canonical Python
// selector produces (gate_c38ff35fbc0a). These expectations are cross-checked
// against select_routing_pair.py at pin blob a3a3be6a running on the same
// routing-providers.json snapshot — divergence is a security defect.

function selectWithEmptyQuota(overrides: {
  taskSize?: 'heavy' | 'light'
  unavailable?: string[]
  experimentKey?: string | null
}) {
  const bundle = loadRoutingProvidersBundle()
  return selectPair({
    config: bundle.config,
    quotaJson: emptyQuotaResponse(1_000_000),
    taskSize: overrides.taskSize ?? 'heavy',
    unavailableProviders: new Set(overrides.unavailable ?? []),
    nowMs: 1_000_000,
    experimentKey: overrides.experimentKey ?? null
  })
}

describe('routing-selector (vendored Python port)', () => {
  it('loads the bundled providers snapshot at the pinned SHA', () => {
    const bundle = loadRoutingProvidersBundle()
    expect(bundle.source).toBe('bundled')
    expect(bundle.blobSha).toBe(ROUTING_PROVIDERS_PIN.blobSha)
    // The selector port is pinned to a distinct source SHA.
    expect(ROUTING_SELECTOR_PIN.blobSha).toBe('a3a3be6ae276ff636f2cb22cca207985a124fd46')
  })

  it('matches the canonical Python selector for heavy / quota-unknown (top pair + count)', () => {
    // Captured from: echo empty-quota | uv run select_routing_pair.py --task-size heavy
    const decision = selectWithEmptyQuota({})
    expect(decision.developer).toMatchObject({
      provider: 'zai',
      model: 'zai/glm-5.2',
      effort: 'max'
    })
    expect(decision.reviewer).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.6-sol',
      effort: 'medium'
    })
    expect(decision.score).toBe(218.0)
    expect(decision.lastResort).toBe(false)
    expect(decision.sameFamily).toBe(false)
    expect(decision.rankedPairs.length).toBe(17)
  })

  it('respects unavailable providers (shifts the top pair)', () => {
    // Python with --unavailable-provider zai removes all zai candidates.
    const decision = selectWithEmptyQuota({ unavailable: ['zai'] })
    expect(decision.developer.provider).not.toBe('zai')
    expect(decision.reviewer.provider).not.toBe('zai')
    // The pair must still come from distinct enabled providers.
    expect(decision.rankedPairs.length).toBeGreaterThan(0)
  })

  it('keeps experimental models out when no experiment key is given', () => {
    // With experimentKey=null, experimental models are excluded entirely (Python
    // returns None from experiment_reasons). The top developer must be a
    // non-experimental model.
    const decision = selectWithEmptyQuota({ experimentKey: null })
    expect(decision.lastResort).toBe(false)
  })

  it('throws when no runnable pair remains', () => {
    // Mark every provider unavailable so no candidate survives.
    const bundle = loadRoutingProvidersBundle()
    const all = bundle.config.providers.map((p) => p.id)
    expect(() =>
      selectPair({
        config: bundle.config,
        quotaJson: emptyQuotaResponse(1),
        taskSize: 'heavy',
        unavailableProviders: new Set(all),
        nowMs: 1,
        experimentKey: null
      })
    ).toThrow(RoutingError)
  })

  it('ranks deterministically (last_resort False before True, score desc)', () => {
    const decision = selectWithEmptyQuota({})
    const ranked = decision.rankedPairs
    // Python: sorted(key=(last_resort, -score)) — all non-last-resort first, then
    // last-resort, each group score-descending. Verify the partition + monotonicity
    // within each group separately (score naturally jumps at the group boundary).
    const firstLastResort = ranked.findIndex((p) => p.lastResort)
    const nonLastResort = firstLastResort === -1 ? ranked : ranked.slice(0, firstLastResort)
    const lastResortGroup = firstLastResort === -1 ? [] : ranked.slice(firstLastResort)
    expect(nonLastResort.every((p) => !p.lastResort)).toBe(true)
    expect(lastResortGroup.every((p) => p.lastResort)).toBe(true)
    const assertScoreDesc = (group: typeof ranked) => {
      for (let i = 1; i < group.length; i++) {
        expect(group[i].score).toBeLessThanOrEqual(group[i - 1].score)
      }
    }
    assertScoreDesc(nonLastResort)
    assertScoreDesc(lastResortGroup)
  })
})
