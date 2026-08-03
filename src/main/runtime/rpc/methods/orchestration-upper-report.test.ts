import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import type { RpcMethod } from '../core'
import { ALL_RPC_METHODS } from './index'

// Why: card 7 fix — a structured upper report (type=status +
// upperReport=true) crosses from the project Run into the named super Run
// only after the server re-proves task+dispatch provenance and the sender's
// pane/role authority. worker_done/heartbeat keep their exact-Dispatch
// anchor; every forgery class fails closed.
describe('orchestration.send structured upper report', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let paneHandles: Record<string, string>
  let runProjId: string
  let runSuperId: string
  let taskId: string
  let dispatchId: string

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
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_sup' ? 'tab_sup:leaf_sup' : null
    )
    runProjId = db.createRun({
      objective: 'project run',
      coordinatorHandle: 'term_sup',
      coordinatorPaneKey: 'tab_sup:leaf_sup'
    }).id
    runSuperId = db.createRun({
      objective: 'super run',
      coordinatorHandle: 'term_super',
      coordinatorPaneKey: 'tab_super:leaf_super'
    }).id
    const task = db.createTask({ spec: 'card 6 work', runId: runProjId })
    taskId = task.id
    dispatchId = db.createDispatchContext(taskId, 'term_worker', 'tab_worker:leaf_worker').id
    db.createRoleRoster({
      pane: 'tab_sup:leaf_sup',
      project: 'proj',
      board: 'board_a',
      role: 'supervisor',
      runId: runProjId,
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

  function upperPayload(overrides?: Record<string, unknown>) {
    return JSON.stringify({
      taskId,
      dispatchId,
      upperReport: true,
      outcome: 'succeeded',
      nextAction: 'dispatch card 7 fix',
      ...overrides
    })
  }

  function seedSuperSupervisor(
    overrides?: Partial<Parameters<OrchestrationDb['createRoleRoster']>[0]>
  ) {
    return db.createRoleRoster({
      pane: 'tab_super:leaf_super',
      project: 'proj',
      board: 'board_a',
      role: 'super_supervisor',
      runId: runSuperId,
      kind: 'supervisor',
      ...overrides
    })
  }

  it('delivers an honest report to the named super Run with server-stamped sourceRunId', async () => {
    const result = (await call({
      from: 'term_sup',
      to: `run:${runSuperId}`,
      type: 'status',
      subject: 'card 6 complete',
      payload: upperPayload({ sourceRunId: 'run_forged' })
    })) as { message: { id: string; run_id: string; to_handle: string } }
    expect(result.message.run_id).toBe(runSuperId)
    expect(result.message.to_handle).toBe(`run:${runSuperId}`)
    const stored = db.getMessageById(result.message.id)
    const storedPayload = JSON.parse(stored?.payload ?? '{}') as Record<string, unknown>
    // Why: the client-supplied forged sourceRunId is overwritten by the
    // server-verified provenance Run before the message lands.
    expect(storedPayload.sourceRunId).toBe(runProjId)
    expect(storedPayload.taskId).toBe(taskId)
    expect(storedPayload.dispatchId).toBe(dispatchId)
    expect(runtime.notifyMessageArrived).toHaveBeenCalledWith(`run:${runSuperId}`, 'status')
  })

  it('delivers the same report through the role path to exactly one super supervisor', async () => {
    seedSuperSupervisor()
    paneHandles['tab_super:leaf_super'] = 'term_super_live'
    const result = (await call({
      from: 'term_sup',
      role: 'super_supervisor',
      project: 'proj',
      board: 'board_a',
      run: runSuperId,
      type: 'status',
      subject: 'card 6 complete',
      payload: upperPayload()
    })) as {
      message: { run_id: string; to_handle: string }
      roleTarget: { handle: string }
    }
    expect(result.message.run_id).toBe(runSuperId)
    expect(result.message.to_handle).toBe('term_super_live')
    expect(result.roleTarget.handle).toBe('term_super_live')
  })

  it('refuses to auto-select when the super role has zero or two-plus candidates', async () => {
    await expect(
      call({
        from: 'term_sup',
        role: 'super_supervisor',
        project: 'proj',
        board: 'board_a',
        run: runSuperId,
        type: 'status',
        subject: 'no candidate',
        payload: upperPayload()
      })
    ).rejects.toMatchObject({ code: 'role_roster_not_found' })

    seedSuperSupervisor()
    seedSuperSupervisor({ pane: 'tab_super2:leaf_super2' })
    await expect(
      call({
        from: 'term_sup',
        role: 'super_supervisor',
        project: 'proj',
        board: 'board_a',
        run: runSuperId,
        type: 'status',
        subject: 'ambiguous',
        payload: upperPayload()
      })
    ).rejects.toMatchObject({ code: 'role_roster_ambiguous' })
  })

  it('keeps plain same-Run status sends with a real dispatchId working', async () => {
    const result = (await call({
      from: 'term_sup',
      to: `run:${runProjId}`,
      type: 'status',
      subject: 'ordinary status',
      payload: JSON.stringify({ dispatchId })
    })) as { message: { run_id: string; payload: string | null } }
    expect(result.message.run_id).toBe(runProjId)
    expect(result.message.payload).toBe(JSON.stringify({ dispatchId }))
  })

  it('rejects a forged dispatchId that does not exist', async () => {
    await expect(
      call({
        from: 'term_sup',
        to: `run:${runSuperId}`,
        type: 'status',
        subject: 'forged',
        payload: upperPayload({ dispatchId: 'ctx_does_not_exist' })
      })
    ).rejects.toMatchObject({ code: 'upper_report_dispatch_not_found' })
  })

  it('rejects a taskId that does not match the dispatch', async () => {
    await expect(
      call({
        from: 'term_sup',
        to: `run:${runSuperId}`,
        type: 'status',
        subject: 'task mismatch',
        payload: upperPayload({ taskId: 'task_other' })
      })
    ).rejects.toMatchObject({ code: 'upper_report_task_mismatch' })
  })

  it('rejects a sender pane without supervisor authority in the source Run', async () => {
    await expect(
      call({
        from: 'term_stranger',
        to: `run:${runSuperId}`,
        type: 'status',
        subject: 'unauthorized',
        payload: upperPayload()
      })
    ).rejects.toMatchObject({ code: 'upper_report_forbidden' })
  })

  // Why: a missing upperReport flag simply opts out of the envelope (plain
  // status semantics); the malformed class covers envelopes that claim
  // upperReport=true but lack one of the other four required fields.
  it.each(['taskId', 'dispatchId', 'outcome', 'nextAction'])(
    'fails closed when the %s field is missing',
    async (field) => {
      const payload = JSON.parse(upperPayload()) as Record<string, unknown>
      delete payload[field]
      await expect(
        call({
          from: 'term_sup',
          to: `run:${runSuperId}`,
          type: 'status',
          subject: 'malformed',
          payload: JSON.stringify(payload)
        })
      ).rejects.toMatchObject({ code: 'upper_report_malformed' })
    }
  )

  it('still rejects worker_done and heartbeat across Run boundaries', async () => {
    await expect(
      call({
        from: 'term_sup',
        to: `run:${runSuperId}`,
        type: 'worker_done',
        subject: 'cross-run done',
        payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
      })
    ).rejects.toMatchObject({ code: 'dispatch_run_mismatch' })
    await expect(
      call({
        from: 'term_sup',
        to: `run:${runSuperId}`,
        type: 'heartbeat',
        subject: 'cross-run beat',
        payload: JSON.stringify({ taskId, dispatchId })
      })
    ).rejects.toMatchObject({ code: 'dispatch_run_mismatch' })
  })

  it('does not treat upperReport=true on non-status types as an upper report', async () => {
    const result = (await call({
      from: 'term_sup',
      to: `run:${runProjId}`,
      type: 'escalation',
      subject: 'plain escalation',
      payload: JSON.stringify({ upperReport: true, note: 'not an upper report' })
    })) as { message: { run_id: string; type: string } }
    expect(result.message.run_id).toBe(runProjId)
    expect(result.message.type).toBe('escalation')
  })
})
