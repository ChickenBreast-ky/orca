export const APP_UPDATE_POLICY = {
  policy: 'manual-local-only',
  automatic: false,
  externalNetwork: false
} as const

export type AppUpdatePolicy = typeof APP_UPDATE_POLICY.policy

export const OFFICIAL_UPDATER_ENDPOINTS = [
  'https://github.com/stablyai/orca/releases.atom',
  'https://github.com/stablyai/orca/releases/download',
  'https://api.github.com/repos/stablyai/orca/releases',
  'https://github.com/stablyai/orca-hourly/releases/download',
  'https://api.github.com/repos/stablyai/orca-hourly/releases',
  'https://onorca.dev/whats-new/changelog.json',
  'https://onorca.dev/whats-new/nudge.json'
] as const
