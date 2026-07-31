export const PRODUCT_IDENTITY = {
  appName: 'Orca Kyle',
  appId: 'com.chickenbreastky.orca-kyle',
  claudeCredentialsService: 'Orca Kyle Claude Code Credentials',
  managedClaudeCredentialsService: 'Orca Kyle Claude Code Managed Credentials',
  computerUseBundleId: 'com.chickenbreastky.orca-kyle.computer-use'
} as const

export function isOrcaKyleBundleIdentifier(value: string): boolean {
  return value === PRODUCT_IDENTITY.appId || value.startsWith(`${PRODUCT_IDENTITY.appId}.`)
}
