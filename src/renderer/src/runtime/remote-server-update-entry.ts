import type { RemoteServerUpdateSupport } from '../../../shared/remote-server-update'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'

export type RemoteServerUpdatePhase =
  | 'checking'
  | 'available'
  | 'current'
  | 'manual'
  | 'offline'
  | 'queued'
  | 'checking-update'
  | 'downloading'
  | 'restarting'
  | 'updated'
  | 'failed'

export type RemoteServerUpdateEntry = {
  environmentId: string
  name: string
  phase: RemoteServerUpdatePhase
  currentVersion: string | null
  targetVersion: string | null
  progress: number | null
  runtimeId: string | null
  liveTabCount: number
  liveLeafCount: number
  support: RemoteServerUpdateSupport | null
  error: string | null
}

export function checkingRemoteServerUpdateEntry(
  environment: PublicKnownRuntimeEnvironment
): RemoteServerUpdateEntry {
  return {
    environmentId: environment.id,
    name: environment.name,
    phase: 'checking',
    currentVersion: null,
    targetVersion: null,
    progress: null,
    runtimeId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    support: null,
    error: null
  }
}
