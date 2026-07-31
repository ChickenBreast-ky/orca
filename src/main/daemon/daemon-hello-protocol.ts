import type { DaemonProductIdentity } from './daemon-product-identity'

export type HelloMessage = {
  type: 'hello'
  version: number
  token: string
  clientId: string
  role: 'control' | 'stream'
  daemonProductIdentity: DaemonProductIdentity
}

export type DaemonEndpointIdentity = {
  pid: number
  startedAtMs: number
  launchNonce: string
}

export type HelloResponse = {
  type: 'hello'
  ok: boolean
  error?: string
  daemonProductIdentity?: DaemonProductIdentity
  daemonIdentity?: DaemonEndpointIdentity
}
