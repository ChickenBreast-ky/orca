// Parsing and validation helpers for the dispatch receipt, split out of
// dispatch-receipt-authority.ts to stay under the per-file line budget.

import { timingSafeEqual } from 'node:crypto'
import type {
  ReceiptBindingExpectation,
  ReceiptPayload,
  ReceiptVerifyFail
} from './dispatch-receipt-authority'

// Strict allowed key set — unknown fields are a signature invalid (msg strict grammar).
export const RECEIPT_ALLOWED_KEYS = new Set([
  'dispatchId',
  'jti',
  'runId',
  'taskId',
  'assigneeHandle',
  'assigneePaneKey',
  'processIncarnation',
  'issuedAt',
  'expiresAt',
  'routingInput',
  'routingOutput',
  'providersPinSha',
  'selectorPinSha',
  'keyId',
  'mac'
])

export function constTimeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8')
  const bBuf = Buffer.from(b, 'utf8')
  if (aBuf.length !== bBuf.length) {
    return false
  }
  return timingSafeEqual(aBuf, bBuf)
}

export function asStringField(
  obj: Record<string, unknown>,
  key: string
): string | null | undefined {
  const v = obj[key]
  if (v === undefined || v === null) {
    return null
  }
  if (typeof v !== 'string') {
    return undefined
  }
  return v.length > 0 ? v : undefined
}

// Optional string binding (assignee handle/pane/incarnation). null/absent is
// valid (worker-start has no terminal yet); any non-string present value is an
// immediate format rejection — never coerced to null (review finding r2-1).
export function asOptionalBindingField(
  obj: Record<string, unknown>,
  key: string
): string | null | undefined {
  const v = obj[key]
  if (v === undefined || v === null) {
    return null
  }
  if (typeof v !== 'string' || v.length === 0) {
    return undefined
  }
  return v
}

export function asNumberField(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key]
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
    return undefined
  }
  return v
}

export function extractPayload(obj: Record<string, unknown>): ReceiptPayload | null {
  const dispatchId = asStringField(obj, 'dispatchId')
  const jti = asStringField(obj, 'jti')
  const runId = asStringField(obj, 'runId')
  const taskId = asStringField(obj, 'taskId')
  const issuedAt = asNumberField(obj, 'issuedAt')
  const expiresAt = asNumberField(obj, 'expiresAt')
  const routingInput = asStringField(obj, 'routingInput')
  const routingOutput = asStringField(obj, 'routingOutput')
  const providersPinSha = asStringField(obj, 'providersPinSha')
  const selectorPinSha = asStringField(obj, 'selectorPinSha')
  const assigneeHandle = asOptionalBindingField(obj, 'assigneeHandle')
  const assigneePaneKey = asOptionalBindingField(obj, 'assigneePaneKey')
  const processIncarnation = asOptionalBindingField(obj, 'processIncarnation')
  if (
    dispatchId === undefined ||
    jti === undefined ||
    jti === null ||
    runId === undefined ||
    runId === null ||
    taskId === undefined ||
    taskId === null ||
    issuedAt === undefined ||
    expiresAt === undefined ||
    routingInput === undefined ||
    routingInput === null ||
    routingOutput === undefined ||
    routingOutput === null ||
    providersPinSha === undefined ||
    providersPinSha === null ||
    selectorPinSha === undefined ||
    selectorPinSha === null ||
    assigneeHandle === undefined ||
    assigneePaneKey === undefined ||
    processIncarnation === undefined
  ) {
    return null
  }
  return {
    dispatchId: dispatchId ?? '',
    jti,
    runId,
    taskId,
    assigneeHandle,
    assigneePaneKey,
    processIncarnation,
    issuedAt,
    expiresAt,
    routingInput,
    routingOutput,
    providersPinSha,
    selectorPinSha
  }
}

function bindingMismatch(field: string): ReceiptVerifyFail {
  return {
    valid: false,
    code: 'receipt_binding_mismatch',
    reason: `Receipt ${field} does not match the request.`
  }
}

export function checkBinding(
  payload: ReceiptPayload,
  expected: ReceiptBindingExpectation
): ReceiptVerifyFail | null {
  if (expected.runId !== undefined && payload.runId !== expected.runId) {
    return bindingMismatch('runId')
  }
  if (expected.taskId !== undefined && payload.taskId !== expected.taskId) {
    return bindingMismatch('taskId')
  }
  if (expected.assigneeHandle !== undefined) {
    if (payload.assigneeHandle === null && expected.assigneeHandle !== null) {
      return bindingMismatch('assigneeHandle')
    }
    if (payload.assigneeHandle !== null && payload.assigneeHandle !== expected.assigneeHandle) {
      return bindingMismatch('assigneeHandle')
    }
  }
  if (expected.assigneePaneKey !== undefined) {
    if (payload.assigneePaneKey === null && expected.assigneePaneKey !== null) {
      return bindingMismatch('assigneePaneKey')
    }
    if (payload.assigneePaneKey !== null && payload.assigneePaneKey !== expected.assigneePaneKey) {
      return bindingMismatch('assigneePaneKey')
    }
  }
  if (expected.processIncarnation !== undefined) {
    if (payload.processIncarnation === null && expected.processIncarnation !== null) {
      return bindingMismatch('processIncarnation')
    }
    if (
      payload.processIncarnation !== null &&
      payload.processIncarnation !== expected.processIncarnation
    ) {
      return bindingMismatch('processIncarnation')
    }
  }
  return null
}
