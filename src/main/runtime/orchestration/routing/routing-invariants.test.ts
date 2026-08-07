import { describe, expect, it } from 'vitest'
import { loadRoutingProvidersBundle } from './routing-bundle'
import { validateProvidersInvariants, PROVIDERS_INVARIANT_DOC } from './routing-invariants'
import type { RoutingProvidersConfig } from './routing-bundle'

function minimalConfig(overrides: {
  weeklyReserve?: number
  enabled?: boolean
  modelEnabled?: boolean
  experimentShare?: number
  models?: number
}): RoutingProvidersConfig {
  const mkModel = (i: number) => ({
    id: `m${i}`,
    role: i === 0 ? ('developer' as const) : ('reviewer' as const),
    effort: 'high',
    quality: 50,
    command: 'cmd',
    enabled: overrides.modelEnabled ?? true,
    lastResortOnly: false,
    experimental: false,
    experimentSharePercent: overrides.experimentShare ?? 100,
    reviewerFamilyAllowlist: []
  })
  return {
    providers: [
      {
        id: 'p1',
        family: 'f1',
        quotaKey: 'p1',
        enabled: overrides.enabled ?? true,
        weeklyReservePercent: overrides.weeklyReserve ?? 10,
        models: Array.from({ length: overrides.models ?? 2 }, (_, i) => mkModel(i))
      }
    ]
  }
}

describe('routing-invariants (msg_9fc2a74784e8 providers table contract)', () => {
  it('accepts the vendored bundled table (real snapshot)', () => {
    const bundle = loadRoutingProvidersBundle()
    expect(validateProvidersInvariants(bundle.config)).toBeNull()
  })

  it('documents the invariant list for review', () => {
    expect(PROVIDERS_INVARIANT_DOC.version).toBe(1)
    expect(PROVIDERS_INVARIANT_DOC.rules.length).toBeGreaterThan(0)
  })

  it('rejects an empty providers array', () => {
    expect(validateProvidersInvariants({ providers: [] })?.code).toBe(
      'providers_invariant_violation'
    )
  })

  it('rejects weeklyReservePercent below the 5% floor', () => {
    const bad = minimalConfig({ weeklyReserve: 4 })
    expect(validateProvidersInvariants(bad)?.reason).toContain('weeklyReservePercent')
  })

  it('rejects weeklyReservePercent above the 40% ceiling', () => {
    const bad = minimalConfig({ weeklyReserve: 41 })
    expect(validateProvidersInvariants(bad)?.code).toBe('providers_invariant_violation')
  })

  it('rejects a provider with no enabled model', () => {
    const bad = minimalConfig({ modelEnabled: false })
    expect(validateProvidersInvariants(bad)?.reason).toContain('no enabled model')
  })

  it('rejects experimentSharePercent outside [0,100]', () => {
    const bad = minimalConfig({ experimentShare: 150 })
    expect(validateProvidersInvariants(bad)?.code).toBe('providers_invariant_violation')
  })
})
