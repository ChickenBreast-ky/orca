import { PRODUCT_IDENTITY } from '../../shared/product-identity'
import { PROTOCOL_VERSION } from './daemon-protocol-version'

export type DaemonProductIdentity = {
  readonly appId: string
  readonly buildVersion: string
  readonly protocolVersion: number
}

export function createDaemonProductIdentity(
  buildVersion = process.env.ORCA_APP_VERSION ?? '0.0.0-dev',
  protocolVersion = PROTOCOL_VERSION
): DaemonProductIdentity {
  return {
    appId: PRODUCT_IDENTITY.appId,
    buildVersion,
    protocolVersion
  }
}

export function sameDaemonProductIdentity(
  left: DaemonProductIdentity,
  right: DaemonProductIdentity
): boolean {
  return (
    left.appId === right.appId &&
    left.buildVersion === right.buildVersion &&
    left.protocolVersion === right.protocolVersion
  )
}

export function parseDaemonProductIdentity(value: unknown): DaemonProductIdentity | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const appId = Object.getOwnPropertyDescriptor(value, 'appId')?.value
  const buildVersion = Object.getOwnPropertyDescriptor(value, 'buildVersion')?.value
  const protocolVersion = Object.getOwnPropertyDescriptor(value, 'protocolVersion')?.value
  if (
    typeof appId !== 'string' ||
    appId.length === 0 ||
    typeof buildVersion !== 'string' ||
    buildVersion.length === 0 ||
    typeof protocolVersion !== 'number' ||
    !Number.isSafeInteger(protocolVersion) ||
    protocolVersion <= 0
  ) {
    return null
  }
  return {
    appId,
    buildVersion,
    protocolVersion
  }
}
