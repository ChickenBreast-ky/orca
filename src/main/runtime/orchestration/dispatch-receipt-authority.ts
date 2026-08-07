// Product-verified dispatch receipt signing authority.
//
// Why: a raw orchestration dispatch that bypasses the skill router must still
// be rejected at the product boundary. The receipt binds a product-computed
// routing selection to a specific dispatch target with a short-lived MAC, so a
// forged / replayed / expired / rotated-key receipt is refused before any PTY
// injection (contracts 2-4, gate_c38ff35fbc0a / msg_062f8162e1c1).
//
// The signing key lives only in app-process memory: random, never persisted to
// file/DB/env/CLI-response/log. A restart rotates it and every outstanding
// short receipt is honestly invalid (contract 2).

import { createHash, createHmac, randomBytes } from 'node:crypto'
import {
  RECEIPT_ALLOWED_KEYS,
  constTimeEquals,
  extractPayload,
  checkBinding
} from './dispatch-receipt-parsing'

const RECEIPT_KEY_BYTES = 32
export const RECEIPT_DOMAIN = 'orca-dispatch-receipt-v1'
export const DEFAULT_RECEIPT_TTL_MS = 120_000
// Tolerance for issuedAt slightly in the future and expiry checks. Reserve and
// dispatch normally share one process/clock (skew ~0); the window covers SSH /
// federation and slow CLI round-trips without making replay practical.
const CLOCK_SKEW_MS = 30_000

// Strict allowed key set — unknown fields are a signature invalid (msg strict grammar).

export type ReceiptAssigneeBinding = {
  assigneeHandle: string | null
  assigneePaneKey: string | null
  processIncarnation: string | null
}

export type ReceiptPayload = {
  readonly dispatchId: string
  readonly jti: string
  readonly runId: string
  readonly taskId: string
  readonly assigneeHandle: string | null
  readonly assigneePaneKey: string | null
  readonly processIncarnation: string | null
  readonly issuedAt: number
  readonly expiresAt: number
  readonly routingInput: string
  readonly routingOutput: string
  readonly providersPinSha: string
  readonly selectorPinSha: string
}

export type SignedReceipt = ReceiptPayload & {
  readonly keyId: string
  readonly mac: string
}

export type ReceiptVerifyOk = { valid: true; receipt: ReceiptPayload }
export type ReceiptVerifyFail = { valid: false; code: string; reason: string }
export type ReceiptVerifyResult = ReceiptVerifyOk | ReceiptVerifyFail

export type ReceiptBindingExpectation = {
  readonly runId?: string
  readonly taskId?: string
  readonly assigneeHandle?: string | null
  readonly assigneePaneKey?: string | null
  readonly processIncarnation?: string | null
}

// Length-prefixed (4-byte big-endian) canonical encoding, matching the
// agent-session-claim-identity convention. Fixed field order + length prefixes
// make field omission/addition/substitution a MAC mismatch, not a silent skip.
function encodeFields(fields: readonly string[]): Buffer {
  const chunks: Buffer[] = []
  for (const field of fields) {
    const value = Buffer.from(field, 'utf8')
    const length = Buffer.allocUnsafe(4)
    length.writeUInt32BE(value.length)
    chunks.push(length, value)
  }
  return Buffer.concat(chunks)
}

function canonicalFields(payload: ReceiptPayload): string[] {
  return [
    RECEIPT_DOMAIN,
    payload.dispatchId,
    payload.jti,
    payload.runId,
    payload.taskId,
    payload.assigneeHandle ?? '',
    payload.assigneePaneKey ?? '',
    payload.processIncarnation ?? '',
    String(payload.issuedAt),
    String(payload.expiresAt),
    payload.routingInput,
    payload.routingOutput,
    payload.providersPinSha,
    payload.selectorPinSha
  ]
}

export class DispatchReceiptAuthority {
  readonly keyId: string

  constructor(
    private readonly key: Buffer,
    private readonly ttlMs: number = DEFAULT_RECEIPT_TTL_MS
  ) {
    if (key.length !== RECEIPT_KEY_BYTES) {
      throw new Error('dispatch_receipt_key_invalid_length')
    }
    this.keyId = createHash('sha256').update(key).digest('base64url').slice(0, 22)
  }

  issueReceipt(
    args: {
      dispatchId: string
      runId: string
      taskId: string
      routingInput: string
      routingOutput: string
      providersPinSha: string
      selectorPinSha: string
    } & ReceiptAssigneeBinding
  ): SignedReceipt {
    const now = Date.now()
    const payload: ReceiptPayload = {
      dispatchId: args.dispatchId,
      jti: `jti_${randomBytes(16).toString('hex')}`,
      runId: args.runId,
      taskId: args.taskId,
      assigneeHandle: args.assigneeHandle,
      assigneePaneKey: args.assigneePaneKey,
      processIncarnation: args.processIncarnation,
      issuedAt: now,
      expiresAt: now + this.ttlMs,
      routingInput: args.routingInput,
      routingOutput: args.routingOutput,
      providersPinSha: args.providersPinSha,
      selectorPinSha: args.selectorPinSha
    }
    const mac = createHmac('sha256', this.key)
      .update(encodeFields(canonicalFields(payload)))
      .digest('base64url')
    return { ...payload, keyId: this.keyId, mac }
  }

  // Verifies MAC, key freshness, expiry/issuance window, and binding against
  // the current request context. The reservation's atomic consume (in db.ts)
  // is the replay/once-only guarantee; this only authenticates the token.
  verifyReceipt(
    encoded: string,
    expected: ReceiptBindingExpectation,
    now: number = Date.now()
  ): ReceiptVerifyResult {
    let parsed: unknown
    try {
      parsed = JSON.parse(encoded)
    } catch {
      return {
        valid: false,
        code: 'receipt_signature_invalid',
        reason: 'Receipt is not valid JSON.'
      }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        valid: false,
        code: 'receipt_signature_invalid',
        reason: 'Receipt is not an object.'
      }
    }
    const obj = parsed as Record<string, unknown>
    // Why (msg strict grammar): reject unknown keys so malformed receipts fail-closed.
    for (const key of Object.keys(obj)) {
      if (!RECEIPT_ALLOWED_KEYS.has(key)) {
        return {
          valid: false,
          code: 'receipt_signature_invalid',
          reason: `Receipt has unknown field: ${key}`
        }
      }
    }
    const payload = extractPayload(obj)
    if (payload === null) {
      return {
        valid: false,
        code: 'receipt_signature_invalid',
        reason: 'Receipt is missing required fields.'
      }
    }
    const keyId = typeof obj.keyId === 'string' ? obj.keyId : ''
    const mac = typeof obj.mac === 'string' ? obj.mac : ''

    // Key rotation check first so a post-restart receipt reports rotation, not tamper.
    if (keyId !== this.keyId) {
      return {
        valid: false,
        code: 'receipt_key_rotated',
        reason: 'Receipt key no longer matches this process.'
      }
    }
    const expectedMac = createHmac('sha256', this.key)
      .update(encodeFields(canonicalFields(payload)))
      .digest('base64url')
    if (!constTimeEquals(mac, expectedMac)) {
      return {
        valid: false,
        code: 'receipt_signature_invalid',
        reason: 'Receipt MAC does not match.'
      }
    }
    if (payload.issuedAt - now > CLOCK_SKEW_MS) {
      return {
        valid: false,
        code: 'receipt_expired',
        reason: 'Receipt issued too far in the future.'
      }
    }
    if (now > payload.expiresAt + CLOCK_SKEW_MS) {
      return { valid: false, code: 'receipt_expired', reason: 'Receipt has expired.' }
    }
    // Why: a non-positive lifetime is structurally invalid.
    if (payload.expiresAt <= payload.issuedAt) {
      return {
        valid: false,
        code: 'receipt_expired',
        reason: 'Receipt expiresAt is not after issuedAt.'
      }
    }
    const bindingFail = checkBinding(payload, expected)
    if (bindingFail) {
      return bindingFail
    }
    return { valid: true, receipt: payload }
  }
}

let processAuthority: DispatchReceiptAuthority | undefined

// Lazily creates and caches a process-wide authority. The key is never exposed
// outside this module and is regenerated only when the process restarts.
export function getProcessDispatchReceiptAuthority(): DispatchReceiptAuthority {
  if (!processAuthority) {
    processAuthority = new DispatchReceiptAuthority(randomBytes(RECEIPT_KEY_BYTES))
  }
  return processAuthority
}

// Test-only escape hatch to reset the process singleton with a known key.
export function resetProcessDispatchReceiptAuthorityForTests(
  authority?: DispatchReceiptAuthority
): void {
  processAuthority = authority
}

export function createEphemeralDispatchReceiptAuthority(
  ttlMs: number = DEFAULT_RECEIPT_TTL_MS
): DispatchReceiptAuthority {
  return new DispatchReceiptAuthority(randomBytes(RECEIPT_KEY_BYTES), ttlMs)
}
