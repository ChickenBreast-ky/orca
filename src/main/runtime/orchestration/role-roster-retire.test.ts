import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { reconcileLifecycleMessage } from './lifecycle-reconciliation'
import { listRoleRosterMembers, showRoleRosterMember } from './role-roster-query'
import { retireRoleRosterMember, type RoleRosterRetireResult } from './role-roster-retire'
import type { RoleRosterRow } from './types'

// Why: card 8 — worker/reviewer sessions are card-scoped. Retiring must keep
// role + stable pane + run_id + last_seen_handle as history while removing the
// record from every active-candidate resolution, and only after the four-step
// card-close checklist passes.
describe('role roster retire', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  const stubRuntime = { resolveCurrentPaneHandle: () => null }

  function seedRun(d: OrchestrationDb): string {
    return d.createRun({
      objective: 'card 8',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_0:leaf_0'
    }).id
  }

  function seedRoster(
    d: OrchestrationDb,
    runId: string,
    overrides?: Partial<Parameters<OrchestrationDb['createRoleRoster']>[0]>
  ): RoleRosterRow {
    return d.createRoleRoster({
      pane: 'tab_1:leaf_1',
      project: 'proj',
      board: 'board_a',
      role: 'card8-worker',
      runId,
      lastSeenHandle: 'term_worker_old',
      ...overrides
    })
  }

  function seedTask(d: OrchestrationDb, runId: string, spec = 'card 8 work'): string {
    return d.createTask({ spec, runId }).id
  }

  // Why: manual completion without a settled worker_report — used by blocker
  // tests that need a completed task but no official worker_done.
  function seedCompletedTask(d: OrchestrationDb, runId: string): string {
    const taskId = seedTask(d, runId)
    d.updateTaskStatus(taskId, 'completed')
    return taskId
  }

  // Why: an official worker_done must go through the full dispatch +
  // lifecycle-reconciliation path so the settled task.result carries
  // provenance='worker_report'. Inserting a raw message would be a fake.
  function seedOfficialWorkerDone(
    d: OrchestrationDb,
    runId: string,
    taskId: string,
    overrides?: { from?: string; pane?: string }
  ): { messageId: string; dispatchId: string } {
    const handle = overrides?.from ?? 'term_worker_old'
    const pane = overrides?.pane ?? 'tab_1:leaf_1'
    d.updateTaskStatus(taskId, 'ready')
    const dispatch = d.createDispatchContext(taskId, handle, pane)
    const msg = d.insertMessage({
      from: handle,
      to: `run:${runId}`,
      subject: 'done',
      body: 'done',
      type: 'worker_done',
      runId,
      senderPaneKey: pane,
      payload: JSON.stringify({ taskId, dispatchId: dispatch.id, outcome: 'succeeded' })
    })
    reconcileLifecycleMessage(d, msg, () => {})
    return { messageId: msg.id, dispatchId: dispatch.id }
  }

  // Why: sends a worker_done that lifecycle reconciliation will reject, then
  // manually completes the task so the test isolates worker_done_recorded.
  function seedRejectedWorkerDone(
    d: OrchestrationDb,
    runId: string,
    taskId: string,
    senderOverrides?: { from?: string; pane?: string }
  ): { messageId: string; dispatchId: string } {
    const handle = 'term_worker_old'
    const pane = 'tab_1:leaf_1'
    d.updateTaskStatus(taskId, 'ready')
    const dispatch = d.createDispatchContext(taskId, handle, pane)
    const attackerHandle = senderOverrides?.from ?? 'term_attacker'
    const attackerPane = senderOverrides?.pane ?? 'tab_evil:leaf_evil'
    const msg = d.insertMessage({
      from: attackerHandle,
      to: `run:${runId}`,
      subject: 'forged done',
      body: 'forged',
      type: 'worker_done',
      runId,
      senderPaneKey: attackerPane,
      payload: JSON.stringify({ taskId, dispatchId: dispatch.id, outcome: 'succeeded' })
    })
    reconcileLifecycleMessage(d, msg, () => {})
    // Why: manually complete so the only blocker is worker_done_recorded.
    d.updateTaskStatus(taskId, 'completed')
    return { messageId: msg.id, dispatchId: dispatch.id }
  }

  function retire(
    d: OrchestrationDb,
    runId: string,
    taskId: string,
    overrides?: Partial<Parameters<typeof retireRoleRosterMember>[0]>
  ): RoleRosterRetireResult {
    return retireRoleRosterMember({
      db: d,
      identity: {
        project: 'proj',
        board: 'board_a',
        role: 'card8-worker',
        pane: 'tab_1:leaf_1',
        runId
      },
      taskId,
      dirtyChangesMoved: true,
      dirtyChangesEvidence: '/tmp/orca-evidence/card8/notes.md',
      ...overrides
    })
  }

  // ── happy path ──

  it('retires only when all four checklist conditions pass, and then active resolve finds none', () => {
    const d = createDb()
    const runId = seedRun(d)
    const roster = seedRoster(d, runId)
    const taskId = seedTask(d, runId)
    seedOfficialWorkerDone(d, runId, taskId)

    const result = retire(d, runId, taskId)

    expect(result.retired).toBe(true)
    expect(result.blockers).toEqual([])
    expect(result.checklist.map((step) => [step.code, step.passed])).toEqual([
      ['single_active_candidate', true],
      ['task_completed', true],
      ['dirty_changes_moved', true],
      ['worker_done_recorded', true]
    ])
    expect(result.member?.status).toBe('retired')
    expect(d.getRoleRoster(roster.id)?.status).toBe('retired')
    expect(
      d.resolveActiveRoleRosterByRole({
        project: 'proj',
        board: 'board_a',
        role: 'card8-worker',
        runId
      })
    ).toBeUndefined()
    expect(
      d.listRoleRosters({
        project: 'proj',
        board: 'board_a',
        role: 'card8-worker',
        status: 'active'
      })
    ).toHaveLength(0)
  })

  it('keeps the retired record in list and history with last_seen_handle, pane, and run_id intact', () => {
    const d = createDb()
    const runId = seedRun(d)
    const roster = seedRoster(d, runId)
    const taskId = seedTask(d, runId)
    seedOfficialWorkerDone(d, runId, taskId)

    retire(d, runId, taskId)

    const stored = d.getRoleRoster(roster.id)
    expect(stored?.last_seen_handle).toBe('term_worker_old')
    expect(stored?.pane).toBe('tab_1:leaf_1')
    expect(stored?.run_id).toBe(runId)
    expect(stored?.role).toBe('card8-worker')

    const listed = listRoleRosterMembers({ db: d, runtime: stubRuntime })
    expect(listed).toHaveLength(1)
    expect(listed[0].status).toBe('retired')
    expect(listed[0].lifecycle).toBe('retired')
    expect(listed[0].lastSeenHandle).toBe('term_worker_old')
    // Why: retired went through the checklist — it is settled history, not a
    // pane still waiting to be cleaned up.
    expect(listed[0].cleanupCandidate).toBe(false)

    expect(() =>
      showRoleRosterMember({
        db: d,
        runtime: stubRuntime,
        identity: { project: 'proj', board: 'board_a', role: 'card8-worker', runId }
      })
    ).toThrowError(/No active role roster record/)
  })

  // ── identity blockers ──

  it('refuses and changes nothing when another active candidate still holds the role', () => {
    const d = createDb()
    const runId = seedRun(d)
    const first = seedRoster(d, runId)
    const second = seedRoster(d, runId, { pane: 'tab_2:leaf_2', lastSeenHandle: 'term_second' })
    const taskId = seedTask(d, runId)
    seedOfficialWorkerDone(d, runId, taskId)

    const result = retire(d, runId, taskId)

    expect(result.retired).toBe(false)
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(['single_active_candidate'])
    expect(result.member).toBeNull()
    expect(d.getRoleRoster(first.id)?.status).toBe('active')
    expect(d.getRoleRoster(second.id)?.status).toBe('active')
  })

  it('refuses a pane that does not match the resolved active candidate', () => {
    const d = createDb()
    const runId = seedRun(d)
    const roster = seedRoster(d, runId)
    const taskId = seedTask(d, runId)
    seedOfficialWorkerDone(d, runId, taskId)

    const result = retireRoleRosterMember({
      db: d,
      identity: {
        project: 'proj',
        board: 'board_a',
        role: 'card8-worker',
        pane: 'tab_9:leaf_9',
        runId
      },
      taskId,
      dirtyChangesMoved: true,
      dirtyChangesEvidence: '/tmp/evidence.md'
    })

    expect(result.retired).toBe(false)
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(['single_active_candidate'])
    expect(d.getRoleRoster(roster.id)?.status).toBe('active')
  })

  // ── task / dirty blockers ──

  it('refuses an in-progress card: the task is not completed', () => {
    const d = createDb()
    const runId = seedRun(d)
    const roster = seedRoster(d, runId)
    const task = d.createTask({ spec: 'still running', runId })
    d.updateTaskStatus(task.id, 'dispatched')

    const result = retire(d, runId, task.id)

    expect(result.retired).toBe(false)
    // Why: a dispatched task also has no settled worker_report, so both
    // task_completed and worker_done_recorded block.
    expect(result.blockers.map((blocker) => blocker.code)).toEqual([
      'task_completed',
      'worker_done_recorded'
    ])
    expect(result.blockers[0].detail).toContain('dispatched')
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(d.getRoleRoster(roster.id)?.status).toBe('active')
  })

  it('refuses when the dirty-change move was not explicitly confirmed', () => {
    const d = createDb()
    const runId = seedRun(d)
    const roster = seedRoster(d, runId)
    const taskId = seedTask(d, runId)
    seedOfficialWorkerDone(d, runId, taskId)

    const unconfirmed = retire(d, runId, taskId, {
      dirtyChangesMoved: false,
      dirtyChangesEvidence: '/tmp/evidence.md'
    })
    expect(unconfirmed.retired).toBe(false)
    expect(unconfirmed.blockers.map((blocker) => blocker.code)).toEqual(['dirty_changes_moved'])

    const noEvidence = retire(d, runId, taskId, {
      dirtyChangesMoved: true,
      dirtyChangesEvidence: undefined
    })
    expect(noEvidence.retired).toBe(false)
    expect(noEvidence.blockers.map((blocker) => blocker.code)).toEqual(['dirty_changes_moved'])

    expect(d.getRoleRoster(roster.id)?.status).toBe('active')
  })

  // ── worker_done_recorded blockers ──

  it('refuses when the same Run has no official worker_done for the task', () => {
    const d = createDb()
    const runId = seedRun(d)
    const roster = seedRoster(d, runId)
    const taskId = seedCompletedTask(d, runId)

    const result = retire(d, runId, taskId)

    expect(result.retired).toBe(false)
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(['worker_done_recorded'])
    expect(d.getRoleRoster(roster.id)?.status).toBe('active')
  })

  it('does not accept a worker_done recorded in a different Run', () => {
    const d = createDb()
    const runId = seedRun(d)
    const otherRunId = d.createRun({
      objective: 'other card',
      coordinatorHandle: 'term_coord_2',
      coordinatorPaneKey: 'tab_8:leaf_8'
    }).id
    const roster = seedRoster(d, runId)
    const taskId = seedCompletedTask(d, runId)
    // Why: raw message in a different Run — never settled, must not count.
    d.insertMessage({
      from: 'term_worker_old',
      to: `run:${otherRunId}`,
      subject: 'done',
      body: 'done',
      type: 'worker_done',
      runId: otherRunId,
      payload: JSON.stringify({ taskId, outcome: 'succeeded' })
    })

    const result = retire(d, runId, taskId)

    expect(result.retired).toBe(false)
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(['worker_done_recorded'])
    expect(d.getRoleRoster(roster.id)?.status).toBe('active')
  })

  // ── card 8 fix: rejected / unauthorized worker_done must not satisfy the checklist ──

  it('refuses when the only worker_done was rejected by lifecycle reconciliation', () => {
    const d = createDb()
    const runId = seedRun(d)
    const roster = seedRoster(d, runId)
    const taskId = seedTask(d, runId)
    seedRejectedWorkerDone(d, runId, taskId)

    const result = retire(d, runId, taskId)

    expect(result.retired).toBe(false)
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(['worker_done_recorded'])
    expect(d.getRoleRoster(roster.id)?.status).toBe('active')
  })

  it('refuses when worker_done arrives from the wrong pane (sender_not_assignee rejection)', () => {
    const d = createDb()
    const runId = seedRun(d)
    const roster = seedRoster(d, runId)
    const taskId = seedTask(d, runId)
    seedRejectedWorkerDone(d, runId, taskId, {
      from: 'term_worker_old',
      pane: 'tab_other:leaf_other'
    })

    const result = retire(d, runId, taskId)

    expect(result.retired).toBe(false)
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(['worker_done_recorded'])
    expect(d.getRoleRoster(roster.id)?.status).toBe('active')
  })

  it('refuses when worker_done references a dispatch for a different task', () => {
    const d = createDb()
    const runId = seedRun(d)
    const roster = seedRoster(d, runId)
    const taskId = seedTask(d, runId)
    // Why: create a second task + dispatch, then send worker_done with the
    // wrong dispatchId, lifecycle rejects as task_dispatch_mismatch.
    const otherTaskId = seedTask(d, runId, 'other task')
    d.updateTaskStatus(otherTaskId, 'ready')
    const otherDispatch = d.createDispatchContext(otherTaskId, 'term_other_worker', 'tab_9:leaf_9')
    d.updateTaskStatus(taskId, 'ready')
    d.createDispatchContext(taskId, 'term_worker_old', 'tab_1:leaf_1')
    const msg = d.insertMessage({
      from: 'term_worker_old',
      to: `run:${runId}`,
      subject: 'wrong dispatch',
      body: 'wrong dispatch',
      type: 'worker_done',
      runId,
      senderPaneKey: 'tab_1:leaf_1',
      payload: JSON.stringify({ taskId, dispatchId: otherDispatch.id, outcome: 'succeeded' })
    })
    reconcileLifecycleMessage(d, msg, () => {})
    d.updateTaskStatus(taskId, 'completed')

    const result = retire(d, runId, taskId)

    expect(result.retired).toBe(false)
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(['worker_done_recorded'])
    expect(d.getRoleRoster(roster.id)?.status).toBe('active')
  })

  it('refuses when worker_done has no outcome field', () => {
    const d = createDb()
    const runId = seedRun(d)
    const roster = seedRoster(d, runId)
    const taskId = seedTask(d, runId)
    d.updateTaskStatus(taskId, 'ready')
    const dispatch = d.createDispatchContext(taskId, 'term_worker_old', 'tab_1:leaf_1')
    const msg = d.insertMessage({
      from: 'term_worker_old',
      to: `run:${runId}`,
      subject: 'no outcome',
      body: 'no outcome',
      type: 'worker_done',
      runId,
      senderPaneKey: 'tab_1:leaf_1',
      payload: JSON.stringify({ taskId, dispatchId: dispatch.id })
    })
    reconcileLifecycleMessage(d, msg, () => {})
    d.updateTaskStatus(taskId, 'completed')

    const result = retire(d, runId, taskId)

    expect(result.retired).toBe(false)
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(['worker_done_recorded'])
    expect(d.getRoleRoster(roster.id)?.status).toBe('active')
  })

  // ── aggregate + edge cases ──

  it('reports every failing condition at once instead of stopping at the first', () => {
    const d = createDb()
    const runId = seedRun(d)
    const roster = seedRoster(d, runId)
    const task = d.createTask({ spec: 'still running', runId })

    const result = retire(d, runId, task.id, { dirtyChangesMoved: false })

    expect(result.retired).toBe(false)
    expect(result.blockers.map((blocker) => blocker.code)).toEqual([
      'task_completed',
      'dirty_changes_moved',
      'worker_done_recorded'
    ])
    expect(d.getRoleRoster(roster.id)?.status).toBe('active')
  })

  it('refuses a task that belongs to a different Run than the roster record', () => {
    const d = createDb()
    const runId = seedRun(d)
    const otherRunId = d.createRun({
      objective: 'other card',
      coordinatorHandle: 'term_coord_2',
      coordinatorPaneKey: 'tab_8:leaf_8'
    }).id
    const roster = seedRoster(d, runId)
    const taskId = seedCompletedTask(d, otherRunId)

    const result = retire(d, runId, taskId)

    expect(result.retired).toBe(false)
    expect(result.blockers.map((blocker) => blocker.code)).toContain('task_completed')
    expect(d.getRoleRoster(roster.id)?.status).toBe('active')
  })

  it('leaves an already retired record alone instead of resurrecting or re-retiring it', () => {
    const d = createDb()
    const runId = seedRun(d)
    const roster = seedRoster(d, runId)
    const taskId = seedTask(d, runId)
    seedOfficialWorkerDone(d, runId, taskId)

    expect(retire(d, runId, taskId).retired).toBe(true)
    const before = d.getRoleRoster(roster.id)

    const second = retire(d, runId, taskId)
    expect(second.retired).toBe(false)
    expect(second.blockers.map((blocker) => blocker.code)).toEqual(['single_active_candidate'])
    expect(d.getRoleRoster(roster.id)).toEqual(before)
  })

  it('never touches messages addressed to the retired identity', () => {
    const d = createDb()
    const runId = seedRun(d)
    seedRoster(d, runId)
    const taskId = seedTask(d, runId)
    seedOfficialWorkerDone(d, runId, taskId)
    const letter = d.insertMessage({
      from: 'term_coord',
      to: 'term_worker_old',
      subject: 'follow-up',
      body: 'read me later',
      runId
    })

    expect(retire(d, runId, taskId).retired).toBe(true)
    expect(d.getMessageById(letter.id)?.body).toBe('read me later')
  })

  it('retires an active record while a retired sibling on the same role is ignored', () => {
    const d = createDb()
    const runId = seedRun(d)
    const older = seedRoster(d, runId, { pane: 'tab_5:leaf_5' })
    const taskId = seedTask(d, runId)
    seedOfficialWorkerDone(d, runId, taskId, { from: 'term_worker_old', pane: 'tab_5:leaf_5' })

    expect(
      retireRoleRosterMember({
        db: d,
        identity: {
          project: 'proj',
          board: 'board_a',
          role: 'card8-worker',
          pane: 'tab_5:leaf_5',
          runId
        },
        taskId,
        dirtyChangesMoved: true,
        dirtyChangesEvidence: '/tmp/evidence.md'
      }).retired
    ).toBe(true)

    const newer = seedRoster(d, runId, { pane: 'tab_6:leaf_6' })
    const result = retireRoleRosterMember({
      db: d,
      identity: {
        project: 'proj',
        board: 'board_a',
        role: 'card8-worker',
        pane: 'tab_6:leaf_6',
        runId
      },
      taskId,
      dirtyChangesMoved: true,
      dirtyChangesEvidence: '/tmp/evidence.md'
    })

    expect(result.retired).toBe(true)
    expect(d.getRoleRoster(older.id)?.status).toBe('retired')
    expect(d.getRoleRoster(newer.id)?.status).toBe('retired')
  })
})
