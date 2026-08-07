// Structural invariants for the vendored routing-providers table.
//
// Why (msg_9fc2a74784e8): the providers table data does NOT require exact-match
// to a pinned SHA (unlike the selector logic, which does). Track-M adaptive
// share tuning mutates routing-providers.json in kyle-agent-skills, so demanding
// exact pin equality would break verification on every tune. Instead the
// product verifies structural + boundary invariants it knows, records the used
// table hash in the receipt/audit (skew observable), and refuses issuance ONLY
// on an invariant violation. The invariant list itself is documented here so it
// is reviewable.

import type { RoutingProvidersConfig } from './routing-bundle'

export const PROVIDERS_INVARIANTS_VERSION = 1

export const PROVIDERS_INVARIANT_DOC = {
  version: PROVIDERS_INVARIANTS_VERSION,
  rules: [
    'providers: non-empty array',
    'providers: at least one enabled provider',
    'provider.weeklyReservePercent: floor 5, ceiling 40',
    'provider.models: non-empty',
    'provider: at least one enabled model',
    'model.role: developer | reviewer',
    'model.experimentSharePercent: 0..100',
    'model: at least one runnable (dev,rev) pair with distinct model ids exists'
  ]
} as const

export type ProvidersInvariantViolation = {
  code: string
  reason: string
}

function rangeCheck(
  value: number,
  min: number,
  max: number,
  field: string
): ProvidersInvariantViolation | null {
  if (!Number.isFinite(value) || value < min || value > max) {
    return {
      code: 'providers_invariant_violation',
      reason: `${field}=${value} is outside [${min}, ${max}]`
    }
  }
  return null
}

// Verifies the structural + boundary invariants the product knows about the
// routing-providers table. Returns null when all invariants hold; a violation
// descriptor otherwise. Does NOT require the table to match a pinned hash — a
// different table is a skew/audit note, not an invariant failure.
export function validateProvidersInvariants(
  config: RoutingProvidersConfig
): ProvidersInvariantViolation | null {
  if (config.providers.length === 0) {
    return { code: 'providers_invariant_violation', reason: 'providers is empty' }
  }
  const enabledProviders = config.providers.filter((p) => p.enabled)
  if (enabledProviders.length === 0) {
    return { code: 'providers_invariant_violation', reason: 'no enabled provider' }
  }

  let hasDev = false
  let hasRev = false

  for (const provider of config.providers) {
    const reserveBad = rangeCheck(
      provider.weeklyReservePercent,
      5,
      40,
      `${provider.id}.weeklyReservePercent`
    )
    if (reserveBad) {
      return reserveBad
    }
    if (provider.models.length === 0) {
      return { code: 'providers_invariant_violation', reason: `${provider.id} has no models` }
    }
    let enabledModelCount = 0
    for (const model of provider.models) {
      if (model.role !== 'developer' && model.role !== 'reviewer') {
        return {
          code: 'providers_invariant_violation',
          reason: `${provider.id}.${model.id} role must be developer|reviewer`
        }
      }
      const shareBad = rangeCheck(
        model.experimentSharePercent,
        0,
        100,
        `${provider.id}.${model.id}.experimentSharePercent`
      )
      if (shareBad) {
        return shareBad
      }
      if (!model.enabled) {
        continue
      }
      enabledModelCount += 1
      if (model.role === 'developer' && provider.enabled) {
        hasDev = true
      }
      if (model.role === 'reviewer' && provider.enabled) {
        hasRev = true
      }
    }
    if (enabledModelCount === 0) {
      return {
        code: 'providers_invariant_violation',
        reason: `${provider.id} has no enabled model`
      }
    }
  }

  // At least one runnable (developer, reviewer) candidate must exist. The
  // distinct-model-id constraint is enforced at selection time (selectPair skips
  // dev.id == rev.id); here we only assert both roles have enabled candidates.
  if (!hasDev) {
    return { code: 'providers_invariant_violation', reason: 'no enabled developer model' }
  }
  if (!hasRev) {
    return { code: 'providers_invariant_violation', reason: 'no enabled reviewer model' }
  }
  return null
}
