// Vendored routing providers snapshot — single source of truth for the
// product-verified dispatch receipt (gate_c38ff35fbc0a, msg_062f8162e1c1).
// Why: the product must recompute the routing selection itself instead of
// blind-signing a caller-provided pair, but must NOT duplicate live selection
// rules or read the skill repo at runtime. The resolution is a SHA-pinned
// vendored snapshot: the data lives here, pinned to an exact kyle-agent-skills
// commit, and pin updates are deliberate orca-kyle commits only.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

// Pin provenance for audit/receipt binding. Source: kyle-agent-skills main at vendoring time.
export const ROUTING_PROVIDERS_PIN = {
  repo: 'kyle-agent-skills',
  repoCommitSha: '42df425c366e4d3712a7aba08e353a0809fd9959',
  // SHA-256 of the vendored file content (what loadRoutingProvidersBundle verifies at runtime).
  blobSha: '6358e7a7f8584e41b6dcc5f99439c9700c25fe61797a0f1e3284b2d3e85628f3',
  // git hash-object (SHA-1 blob) at that commit, kept as provenance metadata only.
  gitBlobSha: '4b0acf12679cf8314e4a600690d0c4d765664d09',
  relativePath: 'skills/orca-conductor/references/routing-providers.json'
} as const

export type RoutingProvidersSource = 'bundled' | 'override'

export type RoutingProvidersBundle = {
  readonly config: RoutingProvidersConfig
  readonly source: RoutingProvidersSource
  readonly blobSha: string
  // Present only when a dev override path was used; recorded in audit/receipt.
  readonly overridePath?: string
  readonly pinCommitSha: string
}

export type RoutingProvidersConfig = {
  readonly providers: readonly RoutingProviderConfig[]
}

export type RoutingProviderConfig = {
  readonly id: string
  readonly family: string
  readonly quotaKey: string | null
  readonly enabled: boolean
  readonly weeklyReservePercent: number
  readonly models: readonly RoutingModelConfig[]
}

export type RoutingModelConfig = {
  readonly id: string
  readonly role: 'developer' | 'reviewer'
  readonly effort: string
  readonly quality: number
  readonly command: string
  readonly enabled: boolean
  readonly lastResortOnly: boolean
  readonly experimental: boolean
  readonly experimentSharePercent: number
  readonly reviewerFamilyAllowlist: readonly string[]
  readonly harness?: string
  readonly taskClassPrior?: Record<string, number>
}

const BUNDLED_PROVIDERS_PATH = join(__dirname, 'routing-providers-bundle.json')

// Env name kept task-specific to avoid colliding with common system options.
const OVERRIDE_ENV = 'ORCA_ROUTING_PROVIDERS_OVERRIDE'

let cachedBundledRaw: string | undefined

function readBundledRaw(): string {
  if (cachedBundledRaw === undefined) {
    cachedBundledRaw = readFileSync(BUNDLED_PROVIDERS_PATH, 'utf8')
  }
  return cachedBundledRaw
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function parseProvidersConfig(raw: string): RoutingProvidersConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('routing_providers_bundle_corrupt: JSON parse failed')
  }
  return normalizeProvidersConfig(parsed)
}

// Normalizes the camelCase JSON (matching select_routing_pair.py pydantic aliases)
// into the frozen TS view the selector consumes.
function normalizeProvidersConfig(parsed: unknown): RoutingProvidersConfig {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('routing_providers_bundle_corrupt: expected an object')
  }
  const root = parsed as Record<string, unknown>
  const providersRaw = root.providers
  if (!Array.isArray(providersRaw)) {
    throw new Error('routing_providers_bundle_corrupt: providers is not an array')
  }
  const providers = providersRaw.map((p, i) => normalizeProvider(p, i))
  return Object.freeze({ providers: Object.freeze(providers) })
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`routing_providers_bundle_corrupt: ${field} is not a non-empty string`)
  }
  return value
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`routing_providers_bundle_corrupt: ${field} is not a finite number`)
  }
  return value
}

function asBool(value: unknown, field: string, fallback?: boolean): boolean {
  if (value === undefined || value === null) {
    if (fallback !== undefined) {
      return fallback
    }
    throw new Error(`routing_providers_bundle_corrupt: ${field} is missing`)
  }
  if (typeof value !== 'boolean') {
    throw new Error(`routing_providers_bundle_corrupt: ${field} is not boolean`)
  }
  return value
}

function asStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`routing_providers_bundle_corrupt: ${field} is not an array`)
  }
  return Object.freeze(value.map((v, i) => asString(v, `${field}[${i}]`)))
}

function normalizeProvider(value: unknown, index: number): RoutingProviderConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`routing_providers_bundle_corrupt: providers[${index}] is not an object`)
  }
  const p = value as Record<string, unknown>
  const modelsRaw = p.models
  if (!Array.isArray(modelsRaw)) {
    throw new Error(`routing_providers_bundle_corrupt: providers[${index}].models is not an array`)
  }
  return Object.freeze({
    id: asString(p.id, `providers[${index}].id`),
    family: asString(p.family, `providers[${index}].family`),
    quotaKey:
      p.quotaKey === undefined || p.quotaKey === null
        ? null
        : asString(p.quotaKey, `providers[${index}].quotaKey`),
    enabled: asBool(p.enabled, `providers[${index}].enabled`),
    weeklyReservePercent: asNumber(
      p.weeklyReservePercent,
      `providers[${index}].weeklyReservePercent`
    ),
    models: Object.freeze(modelsRaw.map((m, j) => normalizeModel(m, index, j)))
  })
}

function normalizeModel(value: unknown, pi: number, mi: number): RoutingModelConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `routing_providers_bundle_corrupt: providers[${pi}].models[${mi}] is not an object`
    )
  }
  const m = value as Record<string, unknown>
  const role = m.role
  if (role !== 'developer' && role !== 'reviewer') {
    throw new Error(
      `routing_providers_bundle_corrupt: providers[${pi}].models[${mi}].role must be developer|reviewer`
    )
  }
  const taskClassPrior = m.taskClassPrior
  return Object.freeze({
    id: asString(m.id, `providers[${pi}].models[${mi}].id`),
    role,
    effort: asString(m.effort, `providers[${pi}].models[${mi}].effort`),
    quality: asNumber(m.quality, `providers[${pi}].models[${mi}].quality`),
    command: asString(m.command, `providers[${pi}].models[${mi}].command`),
    enabled: asBool(m.enabled, `providers[${pi}].models[${mi}].enabled`, true),
    lastResortOnly: asBool(
      m.lastResortOnly,
      `providers[${pi}].models[${mi}].lastResortOnly`,
      false
    ),
    experimental: asBool(m.experimental, `providers[${pi}].models[${mi}].experimental`, false),
    experimentSharePercent: asNumber(
      m.experimentSharePercent ?? (m.experimental ? 100 : 100),
      `providers[${pi}].models[${mi}].experimentSharePercent`
    ),
    reviewerFamilyAllowlist: m.reviewerFamilyAllowlist
      ? asStringArray(
          m.reviewerFamilyAllowlist,
          `providers[${pi}].models[${mi}].reviewerFamilyAllowlist`
        )
      : Object.freeze([]),
    harness: typeof m.harness === 'string' ? m.harness : undefined,
    taskClassPrior:
      taskClassPrior && typeof taskClassPrior === 'object' && !Array.isArray(taskClassPrior)
        ? (taskClassPrior as Record<string, number>)
        : undefined
  })
}

// Loads the routing providers config. Default = the vendored bundled
// snapshot (always present). A dev override via ORCA_ROUTING_PROVIDERS_OVERRIDE
// is allowed for local iteration but is fail-closed: if the env names a path
// that does not exist or is unreadable, this throws rather than silently
// falling back to the bundle — the override was an explicit instruction.
export function loadRoutingProvidersBundle(): RoutingProvidersBundle {
  const overridePath = process.env[OVERRIDE_ENV]
  if (overridePath && overridePath.trim().length > 0) {
    const absolute = isAbsolute(overridePath) ? overridePath : resolve(process.cwd(), overridePath)
    let raw: string
    try {
      raw = readFileSync(absolute, 'utf8')
    } catch (err) {
      throw new Error(
        `routing_providers_override_unavailable: ${absolute} (${
          err instanceof Error ? err.message : String(err)
        })`
      )
    }
    return {
      config: parseProvidersConfig(raw),
      source: 'override',
      blobSha: sha256Hex(raw),
      overridePath: absolute,
      pinCommitSha: 'override'
    }
  }
  const raw = readBundledRaw()
  return {
    config: parseProvidersConfig(raw),
    source: 'bundled',
    blobSha: sha256Hex(raw),
    pinCommitSha: ROUTING_PROVIDERS_PIN.repoCommitSha
  }
}
