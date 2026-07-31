import type { UpdateStatus } from './types'

export const REMOTE_SERVER_UPDATE_CAPABILITY = 'updater.remote-control.v1' as const

export type RemoteServerUpdateInstallMode =
  | 'interactive'
  | 'supervised-headless-serve'
  | 'unsupported-headless-serve'

export type RemoteServerUpdateSupport = {
  installMode: RemoteServerUpdateInstallMode
  automatic: boolean
  reason:
    | 'available'
    | 'manual-service-update-required'
    | 'manual-local-install-required'
    | 'unpackaged-build'
    | 'updater-unavailable'
}

export type RemoteServerUpdaterSnapshot = {
  appVersion: string
  runtimeId: string
  support: RemoteServerUpdateSupport
  status: UpdateStatus
}

export type RemoteServerUpdateInstallResult =
  | {
      accepted: true
      fromVersion: string
      targetVersion: string
      runtimeId: string
    }
  | {
      accepted: false
      reason: 'manual-local-install-required'
      runtimeId: string
    }
