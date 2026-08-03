import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import type { RpcMethod } from '../core'
import { ALL_RPC_METHODS } from './index'

// Why: card 4 — send by role. project+board+role+run picks exactly one active
// roster record; the stable pane resolves the current handle a same-turn
// re-resolve guards; cached handles and titles never participate. Lifecycle
// capability and Run Delivery contracts are unchanged by role targeting.
describe('orchestration.send role targeting', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let paneHandles: Record<string, string>

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
  })

  afterEach(() => db.close())

  function sendMethod(): RpcMethod {
    const method = ALL_RPC_METHODS.find((candidate) => candidate.name === 'orchestration.send')
    if (!method) {
      throw new Error('orchestration.send is not registered')
    }
    return method as RpcMethod
  }

  function call(params: Record<string, unknown>, ctx?: Record<string, unknown>) {
    const method = sendMethod()
    return method.handler(method.params!.parse(params), { runtime, ...ctx })
  }

  function seedRoster(overrides?: Partial<Parameters<OrchestrationDb['createRoleRoster']>[0]>) {
    return db.createRoleRoster({
      pane: 'tab_sup:leaf_sup',
      project: 'proj',
      board: 'board_a',
      role: 'supervisor',
      runId: runProjId,
      ...overrides
    })
  }

  let runProjId: string
  let runSuperId: string

  beforeEach(() => {
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
  })

  it('sends to the project supervisor role by its current pane handle', async () => {
    seedRoster({ lastSeenHandle: 'term_A' })
    paneHandles['tab_sup:leaf_sup'] = 'term_B'
    const result = (await call({
      from: 'term_worker',
      role: 'supervisor',
      project: 'proj',
      board: 'board_a',
      run: runProjId,
      subject: 'card 4 done'
    })) as {
      message: { to_handle: string; run_id: string }
      roleTarget: { handle: string; pane: string; handleRefreshed: boolean }
    }
    expect(result.message.to_handle).toBe('term_B')
    expect(result.message.run_id).toBe(runProjId)
    expect(result.roleTarget).toMatchObject({
      handle: 'term_B',
      pane: 'tab_sup:leaf_sup',
      handleRefreshed: true
    })
    expect(runtime.notifyMessageArrived).toHaveBeenCalledWith('term_B', expect.anything())
  })

  it('sends to the super supervisor role on its own Run', async () => {
    seedRoster({
      pane: 'tab_super:leaf_super',
      role: 'super_supervisor',
      runId: runSuperId,
      kind: 'supervisor'
    })
    paneHandles['tab_super:leaf_super'] = 'term_super_live'
    const result = (await call({
      from: 'term_coord',
      role: 'super_supervisor',
      project: 'proj',
      board: 'board_a',
      run: runSuperId,
      subject: 'board complete'
    })) as { message: { to_handle: string; run_id: string } }
    expect(result.message.to_handle).toBe('term_super_live')
    expect(result.message.run_id).toBe(runSuperId)
  })

  it('fails closed with structured codes for every ambiguity class', async () => {
    const base = {
      from: 'term_worker',
      role: 'supervisor',
      project: 'proj',
      board: 'board_a',
      run: runProjId,
      subject: 'hi'
    }
    await expect(call(base)).rejects.toMatchObject({ code: 'role_roster_not_found' })

    seedRoster({ pane: 'tab_1:leaf_1' })
    seedRoster({ pane: 'tab_2:leaf_2' })
    await expect(call(base)).rejects.toMatchObject({ code: 'role_roster_ambiguous' })
  })

  it('distinguishes an unresolved pane from a disconnected runtime', async () => {
    seedRoster()
    const base = {
      from: 'term_worker',
      role: 'supervisor',
      project: 'proj',
      board: 'board_a',
      run: runProjId,
      subject: 'hi'
    }
    await expect(call(base)).rejects.toMatchObject({ code: 'role_roster_pane_unresolved' })
    vi.mocked(runtime.resolveTerminalPane).mockImplementation(() => {
      throw new Error('relay connection lost')
    })
    await expect(call(base)).rejects.toMatchObject({ code: 'role_roster_runtime_disconnected' })
    expect(db.getInbox()).toHaveLength(0)
  })

  it('delivers to B only after an A-to-B remint keeps the same role record', async () => {
    const roster = seedRoster({ lastSeenHandle: 'term_A' })
    paneHandles['tab_sup:leaf_sup'] = 'term_B'
    const result = (await call({
      from: 'term_worker',
      role: 'supervisor',
      project: 'proj',
      board: 'board_a',
      run: runProjId,
      subject: 'after remint'
    })) as { message: { to_handle: string } }
    expect(result.message.to_handle).toBe('term_B')
    expect(db.getRoleRoster(roster.id)?.last_seen_handle).toBe('term_B')
  })

  it('fails closed when the handle changes between resolve and send', async () => {
    seedRoster()
    const handles = ['term_A', 'term_B']
    vi.mocked(runtime.resolveTerminalPane).mockImplementation(() => {
      return { handle: handles.shift() ?? 'term_B' } as never
    })
    await expect(
      call({
        from: 'term_worker',
        role: 'supervisor',
        project: 'proj',
        board: 'board_a',
        run: runProjId,
        subject: 'race'
      })
    ).rejects.toMatchObject({ code: 'role_roster_handle_changed' })
    expect(db.getInbox()).toHaveLength(0)
  })

  it('rejects a raw handle combined with a role target and incomplete identities', () => {
    const method = sendMethod()
    expect(() =>
      method.params!.parse({
        to: 'term_raw',
        role: 'supervisor',
        project: 'proj',
        board: 'board_a',
        run: runProjId,
        subject: 'conflict'
      })
    ).toThrow()
    expect(() =>
      method.params!.parse({ role: 'supervisor', project: 'proj', subject: 'missing fields' })
    ).toThrow()
  })

  it('keeps lifecycle capability authority on a role-targeted worker_done', async () => {
    const run = db.createRun({
      objective: 'role lifecycle',
      coordinatorHandle: 'term_sup',
      coordinatorPaneKey: 'tab_sup:leaf_sup'
    })
    seedRoster({ runId: run.id, lastSeenHandle: 'term_sup' })
    paneHandles['tab_sup:leaf_sup'] = 'term_sup'
    const task = db.createTask({ spec: 'capability via role', runId: run.id })
    const dispatch = db.createDispatchContext(task.id, 'term_worker', 'tab_worker:leaf_worker')
    const capability = db.mintDispatchCapability({
      dispatchId: dispatch.id,
      paneKey: 'tab_worker:leaf_worker',
      processIncarnation: 'runtime_test:term_worker:1'
    })
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_worker' ? 'tab_worker:leaf_worker' : null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === 'term_worker' ? 'runtime_test:term_worker:1' : null
    )
    const params = {
      from: 'term_worker',
      role: 'supervisor',
      project: 'proj',
      board: 'board_a',
      run: run.id,
      subject: 'Done',
      type: 'worker_done',
      payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id, outcome: 'succeeded' })
    }
    const rejected = (await call(params)) as {
      lifecycle: { code: string }
      roleTarget?: { handle: string }
    }
    expect(rejected.lifecycle.code).toBe('dispatch_capability_invalid')
    // Why: an unauthorized sender must not learn the role's current handle
    // from a rejection — redact roleTarget from the external response only.
    expect(rejected.roleTarget).toBeUndefined()
    expect(JSON.stringify(rejected)).not.toContain('term_sup')

    const accepted = (await call(params, { orchestrationCapability: capability })) as {
      message: { to_handle: string; run_id: string }
      lifecycle?: { action: string }
      roleTarget?: { handle: string }
    }
    // Why: worker_done keeps the exact-Dispatch Run-mailbox contract — the
    // role target records the intended recipient but lifecycle mail still
    // lands in the Run home the supervisor is bound to.
    expect(accepted.message.to_handle).toBe(`run:${run.id}`)
    expect(accepted.message.run_id).toBe(run.id)
    expect(accepted.roleTarget?.handle).toBe('term_sup')
    expect(db.getTask(task.id)?.status).toBe('completed')
  })
})
