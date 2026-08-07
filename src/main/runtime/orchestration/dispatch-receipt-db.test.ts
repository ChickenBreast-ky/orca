import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { Worker } from 'node:worker_threads'

describe('dispatch receipt reservations (schema v23)', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function setup() {
    db = new OrchestrationDb(':memory:')
    const run = db!.createRun({
      objective: 'Receipt test',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:11111111-1111-4111-8111-111111111111'
    })
    const task = db!.createTask({ spec: 'work', runId: run.id })
    return { run, task }
  }

  function reserveArgs(dispatchId: string, jti: string, runId: string, taskId: string) {
    return {
      dispatchId,
      jti,
      runId,
      taskId,
      assigneeHandle: 'term_worker',
      assigneePaneKey: 'pane_1',
      processIncarnation: 'inc_1',
      routingInputJson: '{"taskSize":"heavy"}',
      routingOutputJson: '{"developer":{"model":"m"}}',
      providersPinSha: 'psha',
      selectorPinSha: 'ssha',
      keyId: 'kid_1',
      issuedAt: 1_000,
      expiresAt: 2_000
    }
  }

  it('creates and reads a reservation in reserved state', () => {
    const { run, task } = setup()
    const dispatchId = db!.generateDispatchContextId()
    const row = db!.createDispatchReceiptReservation(
      reserveArgs(dispatchId, 'jti_1', run.id, task.id)
    )
    expect(row.dispatch_id).toBe(dispatchId)
    expect(row.status).toBe('reserved')
    expect(row.jti).toBe('jti_1')
  })

  it('consumes a reservation exactly once (replay returns null)', () => {
    const { run, task } = setup()
    const dispatchId = db!.generateDispatchContextId()
    db!.createDispatchReceiptReservation(reserveArgs(dispatchId, 'jti_1', run.id, task.id))
    const first = db!.consumeDispatchReceiptReservation(dispatchId, 'jti_1')
    expect(first).not.toBeNull()
    expect(first!.status).toBe('consumed')
    // Replay: same dispatchId + jti already consumed.
    const second = db!.consumeDispatchReceiptReservation(dispatchId, 'jti_1')
    expect(second).toBeNull()
  })

  it('concurrent double-consume via worker threads yields exactly one success', async () => {
    // Why (r2-3): two worker threads open separate DatabaseSync connections and
    // race the consume UPDATE behind an Atomics barrier — real concurrency, not
    // two synchronous calls in sequence. busy_timeout lets the loser retry then
    // observe status='consumed' (changes=0 → null).
    const dir = mkdtempSync(join(tmpdir(), 'receipt-concurrent-'))
    try {
      const dbPath = resolvePath(join(dir, 'test.db'))
      const writer = new OrchestrationDb(dbPath)
      const run = writer.createRun({
        objective: 'Concurrent test',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: 'tab_coord:22222222-2222-4222-8222-222222222222'
      })
      const task = writer.createTask({ spec: 'work', runId: run.id })
      const dispatchId = writer.generateDispatchContextId()
      writer.createDispatchReceiptReservation(reserveArgs(dispatchId, 'jti_1', run.id, task.id))
      writer.close()

      // Each worker opens its own DatabaseSync connection, signals ready, waits
      // for a go signal, then races the consume UPDATE. Real thread-level
      // concurrency, not two synchronous calls in one event loop.
      const workerCode = [
        "const { DatabaseSync } = require('node:sqlite')",
        "const { parentPort, workerData } = require('node:worker_threads')",
        'const db = new DatabaseSync(workerData.dbPath)',
        "db.exec('PRAGMA busy_timeout = 5000')",
        "parentPort.postMessage('ready')",
        "parentPort.once('message', (msg) => {",
        "  if (msg !== 'go') return",
        '  const stmt = db.prepare(',
        "    \"UPDATE dispatch_receipt_reservations SET status = 'consumed', consumed_at = datetime('now') WHERE dispatch_id = ? AND jti = ? AND status = 'reserved'\"",
        '  )',
        '  const result = stmt.run(workerData.dispatchId, workerData.jti)',
        '  db.close()',
        '  parentPort.postMessage(result.changes)',
        '})'
      ].join('\n')
      const makeWorker = () =>
        new Worker(workerCode, { eval: true, workerData: { dbPath, dispatchId, jti: 'jti_1' } })

      const w1 = makeWorker()
      const w2 = makeWorker()
      await Promise.all([
        new Promise<void>((res) => w1.once('message', () => res())),
        new Promise<void>((res) => w2.once('message', () => res()))
      ])
      w1.postMessage('go')
      w2.postMessage('go')
      const [r1, r2] = await Promise.all([
        new Promise<number>((res) => w1.once('message', (c) => res(c as number))),
        new Promise<number>((res) => w2.once('message', (c) => res(c as number)))
      ])
      await Promise.all([w1.terminate(), w2.terminate()])

      const wins = [r1, r2].filter((c) => c === 1)
      expect(wins.length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects consumption with a mismatched jti', () => {
    const { run, task } = setup()
    const dispatchId = db!.generateDispatchContextId()
    db!.createDispatchReceiptReservation(reserveArgs(dispatchId, 'jti_1', run.id, task.id))
    const wrong = db!.consumeDispatchReceiptReservation(dispatchId, 'jti_OTHER')
    expect(wrong).toBeNull()
  })

  it('rejects consumption of an unknown dispatchId', () => {
    setup()
    const unknown = db!.consumeDispatchReceiptReservation('ctx_missing', 'jti_1')
    expect(unknown).toBeNull()
  })

  it('enforces jti uniqueness across reservations', () => {
    const { run, task } = setup()
    const a = db!.generateDispatchContextId()
    db!.createDispatchReceiptReservation(reserveArgs(a, 'jti_shared', run.id, task.id))
    const b = db!.generateDispatchContextId()
    expect(() =>
      db!.createDispatchReceiptReservation(reserveArgs(b, 'jti_shared', run.id, task.id))
    ).toThrow()
  })

  it('reuses a reserved ctx_ id when creating a dispatch context', () => {
    const { task } = setup()
    // Mark the task ready so createDispatchContext accepts it.
    db!.updateTaskStatus(task.id, 'ready')
    const dispatchId = db!.generateDispatchContextId()
    const ctx = db!.createDispatchContext(task.id, 'term_worker', 'pane_1', undefined, dispatchId)
    expect(ctx.id).toBe(dispatchId)
  })
})
