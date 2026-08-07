// Quota health scoring for the vendored routing selector, ported from
// select_routing_pair.py quota_health() (pin a3a3be6a). Split out of
// routing-selector.ts to keep that file under the per-file line budget.

import type { RoutingProviderConfig } from './routing-bundle'

const WEEK_MS = 604_800_000
const FIVE_HOURS_MS = 18_000_000
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const WEEKLY_RESET_URGENCY_MAX_SCORE = 15.0

export type QuotaMetrics = {
  readonly fiveHourPercent: number | null
  readonly fiveHourResetAt: number | null
  readonly weeklyPercent: number | null
  readonly weeklyResetAt: number | null
}

export type QuotaReport = {
  readonly provider: string
  readonly updatedAt: number | null
  readonly quota: QuotaMetrics | null
}

export type QuotaResponse = {
  readonly generatedAt: number
  readonly reports: readonly QuotaReport[]
}

export type ProviderHealth = {
  available: boolean
  lastResort: boolean
  score: number
  reasons: string[]
}

function releaseFactor(resetMs: number | null, nowMs: number, releaseWindowMs: number): number {
  if (resetMs === null) {
    return 1.0
  }
  return Math.max(0.0, Math.min(1.0, (resetMs - nowMs) / releaseWindowMs))
}

export function quotaHealth(
  provider: RoutingProviderConfig,
  cost: number,
  quota: QuotaMetrics | null,
  nowMs: number
): ProviderHealth {
  if (quota === null) {
    return { available: true, lastResort: false, score: 5, reasons: ['quota_unknown'] }
  }
  let score = 0.0
  let lastResort = false
  const reasons: string[] = []
  const weeklyReserve =
    provider.weeklyReservePercent * releaseFactor(quota.weeklyResetAt, nowMs, DAY_MS)
  const fiveHourHeadroom = 1 + 0.5 * releaseFactor(quota.fiveHourResetAt, nowMs, HOUR_MS)
  reasons.push(
    `weekly_reserve=${weeklyReserve.toFixed(2)}`,
    `five_hour_headroom=${fiveHourHeadroom.toFixed(2)}`
  )

  const windows: readonly (readonly [string, number | null, number | null, number, number])[] = [
    ['weekly', quota.weeklyPercent, quota.weeklyResetAt, WEEK_MS, weeklyReserve],
    [
      'five_hour',
      quota.fiveHourPercent,
      quota.fiveHourResetAt,
      FIVE_HOURS_MS,
      cost * (fiveHourHeadroom - 1)
    ]
  ]
  for (const [name, used, resetMs, durationMs, reserve] of windows) {
    if (used === null) {
      continue
    }
    const remainingAfter = 100 - used - cost
    if (remainingAfter < 0) {
      return { available: false, lastResort: true, score: -1000, reasons: [`${name}_exhausted`] }
    }
    score += remainingAfter * 0.15
    if (remainingAfter < reserve) {
      lastResort = true
      score -= 45
      reasons.push(`${name}_reserve_breach`)
    }
    if (resetMs !== null) {
      const elapsed = Math.max(1.0, Math.min(100.0, (1 - (resetMs - nowMs) / durationMs) * 100))
      const pace = used / elapsed
      if (pace > 1) {
        score -= (pace - 1) * 20
        reasons.push(`${name}_pace=${pace.toFixed(2)}`)
      }
    }
  }
  if (quota.weeklyPercent !== null && quota.weeklyResetAt !== null) {
    const timeUntilWeeklyReset = quota.weeklyResetAt - nowMs
    if (0 <= timeUntilWeeklyReset && timeUntilWeeklyReset < DAY_MS) {
      const weeklyResetUrgency =
        WEEKLY_RESET_URGENCY_MAX_SCORE * (1 - timeUntilWeeklyReset / DAY_MS)
      score += weeklyResetUrgency
      reasons.push(`weekly_reset_urgency=${weeklyResetUrgency.toFixed(2)}`)
    }
  }
  return {
    available: true,
    lastResort,
    score,
    reasons: reasons.length > 0 ? reasons : ['quota_healthy']
  }
}

export function asFiniteNumber(
  value: unknown,
  field: string,
  error: (msg: string) => Error
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw error(`quota_parse_failed: ${field} is not a finite number`)
  }
  return value
}

function parseQuotaMetrics(value: unknown, error: (msg: string) => Error): QuotaMetrics | null {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw error('quota_parse_failed: quota is not an object')
  }
  const m = value as Record<string, unknown>
  const opt = (v: unknown, f: string): number | null =>
    v === undefined || v === null ? null : asFiniteNumber(v, f, error)
  return {
    fiveHourPercent: opt(m.fiveHourPercent, 'fiveHourPercent'),
    fiveHourResetAt: opt(m.fiveHourResetAt, 'fiveHourResetAt'),
    weeklyPercent: opt(m.weeklyPercent, 'weeklyPercent'),
    weeklyResetAt: opt(m.weeklyResetAt, 'weeklyResetAt')
  }
}

// Accepts the same alias JSON shape select_routing_pair.py emits/consumes.
export function parseQuotaResponse(raw: string, error: (msg: string) => Error): QuotaResponse {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw error('quota_parse_failed: JSON parse error')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw error('quota_parse_failed: root is not an object')
  }
  const root = parsed as Record<string, unknown>
  const reportsRaw = root.reports
  if (!Array.isArray(reportsRaw)) {
    throw error('quota_parse_failed: reports is not an array')
  }
  const reports: QuotaReport[] = reportsRaw.map((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      throw error(`quota_parse_failed: reports[${i}] is not an object`)
    }
    const report = r as Record<string, unknown>
    return {
      provider: typeof report.provider === 'string' ? report.provider : '',
      updatedAt:
        report.updatedAt === undefined || report.updatedAt === null
          ? null
          : asFiniteNumber(report.updatedAt, `reports[${i}].updatedAt`, error),
      quota: parseQuotaMetrics(report.quota, error)
    }
  })
  return {
    generatedAt: asFiniteNumber(root.generatedAt, 'generatedAt', error),
    reports: Object.freeze(reports)
  }
}

// Empty quota response — every provider is treated as quota_unknown.
export function emptyQuotaResponse(nowMs: number): string {
  return JSON.stringify({ generatedAt: nowMs, reports: [] })
}
