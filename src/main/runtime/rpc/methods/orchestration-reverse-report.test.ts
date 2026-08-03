import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import type { RpcMethod } from '../core'
import { ALL_RPC_METHODS } from './index'

// Why: card 7 — a structured reverse report (type=status +
// payload.superReply=true) routes a super supervisor reply into the correct
// project Run Delivery instead of screen injection. The message lands at
// run:<project_run_id> (Run Delivery path), never at a terminal handle
// (push-on-idle path). Ordinary status and upperReport paths are untouched.
describe('orchestration.send structured reverse report', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let paneHandles: Record<string, string>
  let runProjId: string
  let runSuperId: string

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    paneHandles = {}
    vi.spyOn(runtime, 'resolveTerminalPane').mockImplementation((paneKey: string) => {
      const handle = paneHandles[paneKey]
      if (!handle) {
        throw new Error('terminal_not_found')
      }
      return { handle } as never
    })
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => {
      if (handle === 'term_super') {
        return 'tab_super:leaf_super'
      }
      if (handle === 'term_proj_sup') {
        return 'tab_proj:leaf_proj'
      }
      return null
    })
    runProjId = db.createRun({
      objective: 'project run',
      coordinatorHandle: 'term_proj_sup',
      coordinatorPaneKey: 'tab_proj:leaf_proj'
    }).id
    runSuperId = db.createRun({
      objective: 'super run',
      coordinatorHandle: 'term_super',
      coordinatorPaneKey: 'tab_super:leaf_super'
    }).id
    db.createRoleRoster({
      pane: 'tab_proj:leaf_proj',
      project: 'proj',
      board: 'board_a',
      role: 'supervisor',
      runId: runProjId,
      kind: 'supervisor'
    })
    db.createRoleRoster({
      pane: 'tab_super:leaf_super',
      project: 'proj',
      board: 'board_a',
      role: 'super_supervisor',
      runId: runSuperId,
      kind: 'supervisor'
    })
  })

  afterEach(() => db.close())

  function sendMethod(): RpcMethod {
    const method = ALL_RPC_METHODS.find((candidate) => candidate.name === 'orchestration.send')
    if (!method) {
      throw new Error('orchestration.send is not registered')
    }
    return method as RpcMethod
  }

  function call(params: Record<string, unknown>) {
    const method = sendMethod()
    return method.handler(method.params!.parse(params), { runtime })
  }

  function reversePayload(overrides?: Record<string, unknown>) {
    return JSON.stringify({
      superReply: true,
      targetRunId: runProjId,
      reply: 'card 7 ack',
      ...overrides
    })
  }

  function checkMethod(): RpcMethod {
    const method = ALL_RPC_METHODS.find((candidate) => candidate.name === 'orchestration.check')
    if (!method) {
      throw new Error('orchestration.check is not registered')
    }
    return method as RpcMethod
  }

  function callCheck(params: Record<string, unknown>) {
    const method = checkMethod()
    return method.handler(method.params!.parse(params), { runtime })
  }

  // (1) super Run official reply routes to project Run Delivery address
  it('delivers a reverse report to the project Run address, not a terminal handle', async () => {
    const result = (await call({
      from: 'term_super',
      to: `run:${runProjId}`,
      type: 'status',
      subject: 'super reply',
      payload: reversePayload({ sourceRunId: 'run_forged' })
    })) as { message: { id: string; run_id: string; to_handle: string } }
    expect(result.message.run_id).toBe(runProjId)
    expect(result.message.to_handle).toBe(`run:${runProjId}`)
    const stored = db.getMessageById(result.message.id)
    const storedPayload = JSON.parse(stored?.payload ?? '{}') as Record<string, unknown>
    // Why: server overwrites forged sourceRunId with verified provenance.
    expect(storedPayload.sourceRunId).toBe(runSuperId)
    expect(runtime.notifyMessageArrived).toHaveBeenCalledWith(`run:${runProjId}`, 'status')
    // Why: R3 regression — super Run mailbox must stay empty (no double-write).
    expect(db.getRunMailboxHistory(runSuperId)).toHaveLength(0)
  })

  // (2) project Run Delivery contains the new message id
  it('the message appears in the project Run Delivery', async () => {
    const sendResult = (await call({
      from: 'term_super',
      to: `run:${runProjId}`,
      type: 'status',
      subject: 'super reply',
      payload: reversePayload()
    })) as { message: { id: string } }

    const gen = db.getRun(runProjId)!.consumer_generation
    const delivery = db.getOrCreateRunDelivery({
      runId: runProjId,
      consumerGeneration: gen
    })
    expect(delivery).toBeDefined()
    expect(delivery!.messages.map((m) => m.id)).toContain(sendResult.message.id)
    // Why: read stays 0 until the companion acks — not auto-marked delivered.
    expect(delivery!.messages[0].read).toBe(0)
    expect(delivery!.messages[0].delivered_at).toBeNull()
  })

  // (3) ack sets read=1 and Delivery status=acknowledged
  it('acknowledging the Delivery sets read=1 and status=acknowledged', async () => {
    const sendResult = (await call({
      from: 'term_super',
      to: `run:${runProjId}`,
      type: 'status',
      subject: 'super reply',
      payload: reversePayload()
    })) as { message: { id: string } }

    const gen = db.getRun(runProjId)!.consumer_generation
    const delivery = db.getOrCreateRunDelivery({
      runId: runProjId,
      consumerGeneration: gen
    })!
    const acked = db.acknowledgeRunDelivery({
      runId: runProjId,
      consumerGeneration: gen,
      deliveryId: delivery.delivery.id
    })
    expect(acked.delivery.status).toBe('acknowledged')
    const msg = db.getMessageById(sendResult.message.id)
    expect(msg?.read).toBe(1)
  })

  // (4) without ack, read=0 and same Delivery reappears
  it('reuses the same outstanding Delivery when not acked', async () => {
    await call({
      from: 'term_super',
      to: `run:${runProjId}`,
      type: 'status',
      subject: 'super reply',
      payload: reversePayload()
    })
    const gen = db.getRun(runProjId)!.consumer_generation
    const first = db.getOrCreateRunDelivery({ runId: runProjId, consumerGeneration: gen })!
    const second = db.getOrCreateRunDelivery({ runId: runProjId, consumerGeneration: gen })
    expect(second).toBeDefined()
    expect(second!.delivery.id).toBe(first.delivery.id)
    expect(second!.replayed).toBe(true)
    expect(second!.messages[0].read).toBe(0)
  })

  // (5) role targeting: stale handle A to B still routes to run address
  it('routes through role targeting to the Run address even with a stale handle', async () => {
    paneHandles['tab_proj:leaf_proj'] = 'term_proj_live_a'
    const result = (await call({
      from: 'term_super',
      role: 'supervisor',
      project: 'proj',
      board: 'board_a',
      run: runProjId,
      type: 'status',
      subject: 'super reply via role',
      payload: reversePayload()
    })) as {
      message: { run_id: string; to_handle: string }
      roleTarget: { handle: string }
    }
    // Why: role resolved the live handle, but the message goes to the Run
    // Delivery address, not the terminal handle.
    expect(result.message.run_id).toBe(runProjId)
    expect(result.message.to_handle).toBe(`run:${runProjId}`)
    expect(result.roleTarget.handle).toBe('term_proj_live_a')

    // Why: stale handle changes — the message is still at run address.
    paneHandles['tab_proj:leaf_proj'] = 'term_proj_live_b'
    const result2 = (await call({
      from: 'term_super',
      role: 'supervisor',
      project: 'proj',
      board: 'board_a',
      run: runProjId,
      type: 'status',
      subject: 'super reply via role 2',
      payload: reversePayload()
    })) as { message: { to_handle: string } }
    expect(result2.message.to_handle).toBe(`run:${runProjId}`)
  })

  // (6) role targeting with zero candidates fails closed
  it('fails closed when the target role has zero active candidates', async () => {
    await expect(
      call({
        from: 'term_super',
        role: 'nonexistent_role',
        project: 'proj',
        board: 'board_a',
        run: runProjId,
        type: 'status',
        subject: 'no candidate',
        payload: reversePayload()
      })
    ).rejects.toMatchObject({ code: 'role_roster_not_found' })
  })

  // (7) role targeting with duplicate candidates fails closed
  it('fails closed when the target role has two active candidates', async () => {
    db.createRoleRoster({
      pane: 'tab_proj2:leaf_proj2',
      project: 'proj',
      board: 'board_a',
      role: 'supervisor',
      runId: runProjId,
      kind: 'supervisor'
    })
    paneHandles['tab_proj2:leaf_proj2'] = 'term_proj2_live'
    await expect(
      call({
        from: 'term_super',
        role: 'supervisor',
        project: 'proj',
        board: 'board_a',
        run: runProjId,
        type: 'status',
        subject: 'ambiguous',
        payload: reversePayload()
      })
    ).rejects.toMatchObject({ code: 'role_roster_ambiguous' })
  })

  // (8) ordinary status keeps legacy terminal-handle behavior (no Run address override)
  it('does not reroute ordinary status to a Run address', async () => {
    paneHandles['tab_proj:leaf_proj'] = 'term_proj_live'
    const result = (await call({
      from: 'term_super',
      role: 'supervisor',
      project: 'proj',
      board: 'board_a',
      run: runProjId,
      type: 'status',
      subject: 'ordinary status',
      payload: JSON.stringify({ note: 'not a reverse report' })
    })) as { message: { to_handle: string } }
    // Why: ordinary status stays on the terminal handle (push-on-idle path).
    expect(result.message.to_handle).toBe('term_proj_live')
  })

  // (9) project to super upperReport still works (regression)
  it('still delivers upper reports to the super Run', async () => {
    const task = db.createTask({ spec: 'card work', runId: runProjId })
    const dispatchId = db.createDispatchContext(task.id, 'term_worker', 'tab_worker:leaf_worker').id
    const result = (await call({
      from: 'term_proj_sup',
      to: `run:${runSuperId}`,
      type: 'status',
      subject: 'upper report',
      payload: JSON.stringify({
        taskId: task.id,
        dispatchId,
        upperReport: true,
        outcome: 'succeeded',
        nextAction: 'next card'
      })
    })) as { message: { run_id: string; to_handle: string } }
    expect(result.message.run_id).toBe(runSuperId)
    expect(result.message.to_handle).toBe(`run:${runSuperId}`)
  })

  // (10) malformed reverse report fails closed before any state change
  it('fails closed when superReply lacks targetRunId', async () => {
    await expect(
      call({
        from: 'term_super',
        to: `run:${runProjId}`,
        type: 'status',
        subject: 'malformed',
        payload: JSON.stringify({ superReply: true })
      })
    ).rejects.toMatchObject({ code: 'reverse_report_malformed' })
  })

  // (11) sender without supervisor authority fails closed
  it('rejects a reverse report from a non-supervisor pane', async () => {
    await expect(
      call({
        from: 'term_stranger',
        to: `run:${runProjId}`,
        type: 'status',
        subject: 'unauthorized',
        payload: reversePayload()
      })
    ).rejects.toMatchObject({ code: 'reverse_report_forbidden' })
  })

  // (12) reverse report is not treated as upperReport and vice versa
  it('does not treat superReply=true on non-status types as a reverse report', async () => {
    const result = (await call({
      from: 'term_super',
      to: `run:${runSuperId}`,
      type: 'escalation',
      subject: 'plain escalation',
      payload: JSON.stringify({ superReply: true, note: 'not a reverse report' })
    })) as { message: { run_id: string; type: string } }
    expect(result.message.run_id).toBe(runSuperId)
    expect(result.message.type).toBe('escalation')
  })

  // (13) A1: omitting --to and --run routes to targetRunId, not sender Run
  it('routes to the target Run Delivery even when --to and --run are omitted', async () => {
    const result = (await call({
      from: 'term_super',
      type: 'status',
      subject: 'reverse reply without --to',
      payload: reversePayload()
    })) as { message: { id: string; run_id: string; to_handle: string } }
    expect(result.message.run_id).toBe(runProjId)
    expect(result.message.to_handle).toBe(`run:${runProjId}`)
  })

  // (14) A1: --to run:A conflicting with payload targetRunId=B fails closed
  it('fails closed when --to run:X conflicts with payload targetRunId', async () => {
    const otherRun = db.createRun({
      objective: 'other run',
      coordinatorHandle: 'term_other',
      coordinatorPaneKey: 'tab_other:leaf_other'
    })
    await expect(
      call({
        from: 'term_super',
        to: `run:${otherRun.id}`,
        type: 'status',
        subject: 'conflicting --to',
        payload: reversePayload()
      })
    ).rejects.toMatchObject({ code: 'reverse_report_target_run_invalid' })
  })

  // (15) R3 중요2: role-path --run X conflicting with targetRunId fires
  // reverse_report_target_run_invalid, not role_roster_not_found
  it('fails closed on --run mismatch via the role path before role_roster_not_found', async () => {
    const otherRun = db.createRun({
      objective: 'other run',
      coordinatorHandle: 'term_other',
      coordinatorPaneKey: 'tab_other:leaf_other'
    })
    await expect(
      call({
        from: 'term_super',
        role: 'nonexistent_role',
        project: 'proj',
        board: 'board_a',
        run: otherRun.id,
        type: 'status',
        subject: 'role --run mismatch',
        payload: reversePayload()
      })
    ).rejects.toMatchObject({ code: 'reverse_report_target_run_invalid' })
  })

  // (16) R3 중요4b: delivered_at-only fake success — a message with
  // delivered_at set but read=0 must reappear in the same outstanding Delivery
  it('a delivered_at-stamped unread message reappears in the same Delivery via check', async () => {
    const sendResult = (await call({
      from: 'term_super',
      to: `run:${runProjId}`,
      type: 'status',
      subject: 'fake delivered_at',
      payload: reversePayload()
    })) as { message: { id: string } }

    // Why: create an outstanding Delivery first (the real check path, not peek),
    // then simulate the old push-on-idle bug by stamping delivered_at without ack.
    const gen = db.getRun(runProjId)!.consumer_generation
    const firstDelivery = db.getOrCreateRunDelivery({
      runId: runProjId,
      consumerGeneration: gen
    })!
    expect(firstDelivery.messages.map((m) => m.id)).toContain(sendResult.message.id)
    const firstDeliveryId = firstDelivery.delivery.id

    db.markAsDelivered([sendResult.message.id])
    const msg = db.getMessageById(sendResult.message.id)
    expect(msg?.read).toBe(0)
    expect(msg?.delivered_at).not.toBeNull()

    // Why: the non-peek check path calls getOrCreateRunDelivery, which must
    // re-surface the same outstanding Delivery (same ID, replayed=true) with
    // the same message still at read=0. If getOrCreateRunDelivery's unread
    // query ever regresses to delivered_at IS NULL, the Delivery would not
    // include this message and the test fails.
    const checkResult = (await callCheck({
      terminal: 'term_proj_sup',
      run: runProjId
    })) as {
      deliveryId: string
      messages: { id: string; read: number }[]
      replayed: boolean
      runId: string
    }
    expect(checkResult.runId).toBe(runProjId)
    expect(checkResult.deliveryId).toBe(firstDeliveryId)
    expect(checkResult.replayed).toBe(true)
    expect(checkResult.messages.map((m) => m.id)).toContain(sendResult.message.id)
    expect(checkResult.messages.find((m) => m.id === sendResult.message.id)?.read).toBe(0)
  })

  // (17) R3 중요4c: malformed reverse report leaves zero state change
  it('a malformed reverse report does not create messages, deliveries, or runs', async () => {
    // Why: seed a real outstanding Delivery with a prior message so the
    // pre/post Delivery snapshot comparison is unconditional.
    await call({
      from: 'term_super',
      to: `run:${runProjId}`,
      type: 'status',
      subject: 'prior message',
      payload: reversePayload()
    })
    const gen = db.getRun(runProjId)!.consumer_generation
    const runBefore = db.getRun(runProjId)!
    const deliveryBefore = db.getOrCreateRunDelivery({
      runId: runProjId,
      consumerGeneration: gen
    })!
    const messagesBefore = db.getRunMailboxHistory(runProjId)

    await expect(
      call({
        from: 'term_super',
        to: `run:${runProjId}`,
        type: 'status',
        subject: 'malformed',
        payload: JSON.stringify({ superReply: true })
      })
    ).rejects.toMatchObject({ code: 'reverse_report_malformed' })

    // Why: message list is identical — no new message was inserted.
    const messagesAfter = db.getRunMailboxHistory(runProjId)
    expect(messagesAfter.length).toBe(messagesBefore.length)
    expect(messagesAfter.map((m) => m.id)).toEqual(messagesBefore.map((m) => m.id))

    // Why: Delivery ID, status, and message_ids are unchanged.
    const deliveryAfter = db.getOrCreateRunDelivery({
      runId: runProjId,
      consumerGeneration: gen
    })
    expect(deliveryAfter).toBeDefined()
    expect(deliveryAfter!.delivery.id).toBe(deliveryBefore.delivery.id)
    expect(deliveryAfter!.delivery.status).toBe(deliveryBefore.delivery.status)
    expect(deliveryAfter!.delivery.message_ids).toBe(deliveryBefore.delivery.message_ids)

    // Why: Run metadata is unchanged.
    const runAfter = db.getRun(runProjId)!
    expect(runAfter.id).toBe(runBefore.id)
    expect(runAfter.objective).toBe(runBefore.objective)
    expect(runAfter.coordinator_pane_key).toBe(runBefore.coordinator_pane_key)
    expect(runAfter.consumer_generation).toBe(runBefore.consumer_generation)
  })

  // (18) R5 중요1: delivered_at-only unread message enters a NEW Delivery
  // (no pre-existing outstanding Delivery) via the unread candidate SQL.
  // Why: db.ts getOrCreateRunDelivery reads read=0 candidates WITHOUT a
  // delivered_at IS NULL filter. If that SQL regresses, this test fails.
  it('a delivered_at-stamped unread message creates a new Delivery via the unread candidate SQL', async () => {
    const gen = db.getRun(runProjId)!.consumer_generation
    // Why: assert no outstanding Delivery exists so the replay branch cannot
    // satisfy this test — only the new-Delivery candidate SQL can.
    expect(db.getOrCreateRunDelivery({ runId: runProjId, consumerGeneration: gen })).toBeUndefined()

    const sendResult = (await call({
      from: 'term_super',
      to: `run:${runProjId}`,
      type: 'status',
      subject: 'new delivery candidate',
      payload: reversePayload()
    })) as { message: { id: string } }

    // Why: simulate the old push-on-idle bug — stamp delivered_at without ack.
    db.markAsDelivered([sendResult.message.id])
    const msg = db.getMessageById(sendResult.message.id)
    expect(msg?.read).toBe(0)
    expect(msg?.delivered_at).not.toBeNull()

    // Why: the non-peek check path calls getOrCreateRunDelivery which runs the
    // unread candidate SQL (read=0, no delivered_at filter). A new Delivery
    // must be created with replayed=false. If AND delivered_at IS NULL is
    // re-added to db.ts:2659-2667, the candidate query returns 0 rows, no
    // Delivery is created, and callCheck returns deliveryId=null — this test
    // fails on the deliveryId assertion.
    const checkResult = (await callCheck({
      terminal: 'term_proj_sup',
      run: runProjId
    })) as {
      deliveryId: string | null
      messages: { id: string; read: number }[]
      replayed: boolean
      runId: string
    }
    expect(checkResult.runId).toBe(runProjId)
    expect(checkResult.deliveryId).not.toBeNull()
    expect(checkResult.replayed).toBe(false)
    expect(checkResult.messages.map((m) => m.id)).toContain(sendResult.message.id)
    expect(checkResult.messages.find((m) => m.id === sendResult.message.id)?.read).toBe(0)
  })
})
