import { describe, expect, it } from 'vitest'
import {
  createEphemeralDispatchReceiptAuthority,
  type DispatchReceiptAuthority,
  RECEIPT_DOMAIN,
  resetProcessDispatchReceiptAuthorityForTests,
  getProcessDispatchReceiptAuthority
} from './dispatch-receipt-authority'

function issueValidReceipt(authority: DispatchReceiptAuthority) {
  return authority.issueReceipt({
    dispatchId: 'ctx_abc123',
    runId: 'run_1',
    taskId: 'task_1',
    assigneeHandle: 'term_worker',
    assigneePaneKey: 'pane_1',
    processIncarnation: 'inc_1',
    routingInput: '{"taskSize":"heavy"}',
    routingOutput: '{"developer":{"model":"zai/glm-5.2"}}',
    providersPinSha: 'psha',
    selectorPinSha: 'ssha'
  })
}

function baseExpectation() {
  return {
    runId: 'run_1',
    taskId: 'task_1',
    assigneeHandle: 'term_worker',
    assigneePaneKey: 'pane_1',
    processIncarnation: 'inc_1'
  }
}

describe('dispatch-receipt-authority', () => {
  it('verifies a receipt it issued (roundtrip)', () => {
    const authority = createEphemeralDispatchReceiptAuthority()
    const receipt = issueValidReceipt(authority)
    const result = authority.verifyReceipt(JSON.stringify(receipt), baseExpectation())
    expect(result.valid).toBe(true)
  })

  it('rejects a forged MAC', () => {
    const authority = createEphemeralDispatchReceiptAuthority()
    const receipt = issueValidReceipt(authority)
    const tampered = { ...receipt, mac: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }
    const result = authority.verifyReceipt(JSON.stringify(tampered), baseExpectation())
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.code).toBe('receipt_signature_invalid')
    }
  })

  it('rejects an added field (extra field breaks canonical MAC)', () => {
    const authority = createEphemeralDispatchReceiptAuthority()
    const receipt = issueValidReceipt(authority)
    const withExtra = { ...receipt, extraField: 'attacker' }
    const result = authority.verifyReceipt(JSON.stringify(withExtra), baseExpectation())
    // Why (msg strict grammar): unknown keys are rejected before MAC check.
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.code).toBe('receipt_signature_invalid')
    }
  })

  it('rejects a non-integer timestamp', () => {
    const authority = createEphemeralDispatchReceiptAuthority()
    const receipt = issueValidReceipt(authority)
    const badTs = { ...receipt, issuedAt: 1785981426037.5 }
    const result = authority.verifyReceipt(JSON.stringify(badTs), baseExpectation())
    expect(result.valid).toBe(false)
  })

  it('rejects expiresAt <= issuedAt', () => {
    // Why: ttlMs=0 makes expiresAt === issuedAt, which is structurally invalid.
    const authority = createEphemeralDispatchReceiptAuthority(0)
    const receipt = issueValidReceipt(authority)
    const result = authority.verifyReceipt(JSON.stringify(receipt), baseExpectation())
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.code).toBe('receipt_expired')
    }
  })

  // Why (r2-1): each optional binding field must reject non-string types instead of coercing to null.
  for (const field of ['assigneeHandle', 'assigneePaneKey', 'processIncarnation'] as const) {
    for (const badValue of [false, 0, [], {}]) {
      it(`rejects a malformed ${field} (${JSON.stringify(badValue)})`, () => {
        const authority = createEphemeralDispatchReceiptAuthority()
        const receipt = issueValidReceipt(authority)
        const bad = { ...receipt, [field]: badValue }
        const result = authority.verifyReceipt(JSON.stringify(bad), baseExpectation())
        expect(result.valid).toBe(false)
      })
    }
  }

  it('accepts a receipt with null assignee bindings (worker-start pre-terminal)', () => {
    const authority = createEphemeralDispatchReceiptAuthority()
    const receipt = authority.issueReceipt({
      dispatchId: 'ctx_null',
      runId: 'run_1',
      taskId: 'task_1',
      assigneeHandle: null,
      assigneePaneKey: null,
      processIncarnation: null,
      routingInput: '{}',
      routingOutput: '{}',
      providersPinSha: 'psha',
      selectorPinSha: 'ssha'
    })
    const result = authority.verifyReceipt(JSON.stringify(receipt), {
      runId: 'run_1',
      taskId: 'task_1'
    })
    expect(result.valid).toBe(true)
  })

  // Why (p1-followup): a worker-start receipt starts with all three assignee
  // fields null. Mutating each to a wrong type must be rejected even though the
  // original MAC covered null values — the malformed JSON fails format parsing
  // before any MAC comparison. 5 bad values x 3 fields = 15 combinations.
  describe('worker-start receipt assignee field type rejection (15 combinations)', () => {
    const badValues = [false, 0, [], {}, '']
    const fields = ['assigneeHandle', 'assigneePaneKey', 'processIncarnation'] as const

    function issueNullAssigneeReceipt(authority: DispatchReceiptAuthority) {
      return authority.issueReceipt({
        dispatchId: 'ctx_worker',
        runId: 'run_1',
        taskId: 'task_1',
        assigneeHandle: null,
        assigneePaneKey: null,
        processIncarnation: null,
        routingInput: '{}',
        routingOutput: '{}',
        providersPinSha: 'psha',
        selectorPinSha: 'ssha'
      })
    }

    for (const field of fields) {
      for (const badValue of badValues) {
        it(`rejects ${field} = ${JSON.stringify(badValue)} on a null-assignee worker-start receipt`, () => {
          const authority = createEphemeralDispatchReceiptAuthority()
          const base = issueNullAssigneeReceipt(authority)
          const tampered = { ...base, [field]: badValue }
          const result = authority.verifyReceipt(JSON.stringify(tampered), {
            runId: 'run_1',
            taskId: 'task_1'
          })
          expect(result.valid).toBe(false)
        })
      }
    }
  })

  it('rejects a mutated bound field (signature invalid)', () => {
    const authority = createEphemeralDispatchReceiptAuthority()
    const receipt = issueValidReceipt(authority)
    // Mutate a MAC-covered field without re-signing.
    const mutated = { ...receipt, taskId: 'task_OTHER' }
    const result = authority.verifyReceipt(JSON.stringify(mutated), baseExpectation())
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.code).toBe('receipt_signature_invalid')
    }
  })

  it('rejects a binding mismatch (different task)', () => {
    const authority = createEphemeralDispatchReceiptAuthority()
    const receipt = issueValidReceipt(authority)
    const result = authority.verifyReceipt(JSON.stringify(receipt), {
      ...baseExpectation(),
      taskId: 'task_OTHER'
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.code).toBe('receipt_binding_mismatch')
    }
  })

  it('rejects a binding mismatch (different pane)', () => {
    const authority = createEphemeralDispatchReceiptAuthority()
    const receipt = issueValidReceipt(authority)
    const result = authority.verifyReceipt(JSON.stringify(receipt), {
      ...baseExpectation(),
      assigneePaneKey: 'pane_OTHER'
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.code).toBe('receipt_binding_mismatch')
    }
  })

  it('rejects an expired receipt', () => {
    const authority = createEphemeralDispatchReceiptAuthority(1)
    const receipt = issueValidReceipt(authority)
    // Issue at now; verify beyond the clock-skew tolerance window.
    const result = authority.verifyReceipt(
      JSON.stringify(receipt),
      baseExpectation(),
      Date.now() + 120_000
    )
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.code).toBe('receipt_expired')
    }
  })

  it('detects key rotation as receipt_key_rotated (post-restart)', () => {
    const oldAuthority = createEphemeralDispatchReceiptAuthority()
    const receipt = issueValidReceipt(oldAuthority)
    // A fresh process has a new random key + keyId.
    const newAuthority = createEphemeralDispatchReceiptAuthority()
    const result = newAuthority.verifyReceipt(JSON.stringify(receipt), baseExpectation())
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.code).toBe('receipt_key_rotated')
    }
  })

  it('rejects malformed JSON', () => {
    const authority = createEphemeralDispatchReceiptAuthority()
    const result = authority.verifyReceipt('not json', baseExpectation())
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.code).toBe('receipt_signature_invalid')
    }
  })

  it('uses a fixed domain string and never writes the key', () => {
    expect(RECEIPT_DOMAIN).toBe('orca-dispatch-receipt-v1')
    const authority = createEphemeralDispatchReceiptAuthority()
    const receipt = issueValidReceipt(authority)
    // The receipt exposes only the keyId digest, never the raw signing key.
    // keyId is a 22-char base64url SHA-256 truncation; a leaked 32-byte key
    // would serialize as a far longer opaque blob.
    const keys = Object.keys(receipt)
    expect(keys).toContain('keyId')
    expect(keys).not.toContain('key')
    expect(receipt.keyId).toMatch(/^[A-Za-z0-9_-]{22}$/)
  })

  it('process singleton is stable within a process and resettable for tests', () => {
    const a = getProcessDispatchReceiptAuthority()
    const b = getProcessDispatchReceiptAuthority()
    expect(a).toBe(b)
    resetProcessDispatchReceiptAuthorityForTests()
    const c = getProcessDispatchReceiptAuthority()
    expect(c).not.toBe(a)
    resetProcessDispatchReceiptAuthorityForTests()
  })
})
