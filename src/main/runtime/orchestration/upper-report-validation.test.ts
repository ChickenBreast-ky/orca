import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { isUpperReportMessage, validateUpperReport } from './upper-report-validation'

// Why: card 7 fix — the structured upper report envelope must re-prove its
// task+dispatch provenance and the sender's pane/role authority against the
// DB; every gap fails closed before a message can cross a Run boundary.
describe('upper report validation', () => {
  let db: OrchestrationDb
  let runId: string
  let taskId: string
  let dispatchId: string

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runId = db.createRun({
      objective: 'project run',
      coordinatorHandle: 'term_sup',
      coordinatorPaneKey: 'tab_sup:leaf_sup'
    }).id
    const task = db.createTask({ spec: 'card work', runId })
    taskId = task.id
    dispatchId = db.createDispatchContext(taskId, 'term_worker', 'tab_worker:leaf_worker').id
  })

  afterEach(() => db.close())

  function seedSupervisor(overrides?: Partial<Parameters<OrchestrationDb['createRoleRoster']>[0]>) {
    return db.createRoleRoster({
      pane: 'tab_sup:leaf_sup',
      project: 'proj',
      board: 'board_a',
      role: 'supervisor',
      runId,
      kind: 'supervisor',
      ...overrides
    })
  }

  function validPayload(overrides?: Record<string, unknown>) {
    return {
      taskId,
      dispatchId,
      upperReport: true,
      outcome: 'succeeded',
      nextAction: 'next card',
      ...overrides
    }
  }

  it('opts in only for type=status with upperReport=true', () => {
    expect(isUpperReportMessage('status', { upperReport: true })).toBe(true)
    expect(isUpperReportMessage('worker_done', { upperReport: true })).toBe(false)
    expect(isUpperReportMessage('status', { upperReport: 1 })).toBe(false)
    expect(isUpperReportMessage('status', { upperReport: false })).toBe(false)
    expect(isUpperReportMessage('status', null)).toBe(false)
  })

  it('accepts an honest report from the project supervisor pane', () => {
    seedSupervisor()
    expect(
      validateUpperReport({ db, payload: validPayload(), senderPaneKey: 'tab_sup:leaf_sup' })
    ).toEqual({ taskId, dispatchId, sourceRunId: runId })
  })

  it('matches the sender pane by stable leaf after a tab break-out', () => {
    const leaf = '11111111-1111-4111-8111-111111111111'
    seedSupervisor({ pane: `tab_sup:${leaf}` })
    expect(
      validateUpperReport({ db, payload: validPayload(), senderPaneKey: `tab_breakout:${leaf}` })
    ).toEqual({ taskId, dispatchId, sourceRunId: runId })
  })

  it.each([
    ['taskId', { taskId: '' }],
    ['dispatchId', { dispatchId: undefined }],
    ['outcome', { outcome: 42 }],
    ['nextAction', { nextAction: undefined }]
  ])('fails closed when the %s field is malformed', (_field, override) => {
    seedSupervisor()
    expect(() =>
      validateUpperReport({
        db,
        payload: validPayload(override as Record<string, unknown>),
        senderPaneKey: 'tab_sup:leaf_sup'
      })
    ).toThrowError(expect.objectContaining({ code: 'upper_report_malformed' }))
  })

  it('rejects a forged dispatchId that does not exist', () => {
    seedSupervisor()
    expect(() =>
      validateUpperReport({
        db,
        payload: validPayload({ dispatchId: 'ctx_does_not_exist' }),
        senderPaneKey: 'tab_sup:leaf_sup'
      })
    ).toThrowError(expect.objectContaining({ code: 'upper_report_dispatch_not_found' }))
  })

  it('rejects a taskId that does not match the dispatch', () => {
    seedSupervisor()
    expect(() =>
      validateUpperReport({
        db,
        payload: validPayload({ taskId: 'task_other' }),
        senderPaneKey: 'tab_sup:leaf_sup'
      })
    ).toThrowError(expect.objectContaining({ code: 'upper_report_task_mismatch' }))
  })

  it('rejects a dispatch whose source Run is legacy', () => {
    seedSupervisor()
    const legacyTask = db.createTask({ spec: 'legacy work' })
    const legacyDispatch = db.createDispatchContext(legacyTask.id, 'term_worker2', 'tab_w2:leaf_w2')
    expect(() =>
      validateUpperReport({
        db,
        payload: validPayload({ taskId: legacyTask.id, dispatchId: legacyDispatch.id }),
        senderPaneKey: 'tab_sup:leaf_sup'
      })
    ).toThrowError(expect.objectContaining({ code: 'upper_report_source_run_invalid' }))
  })

  it('rejects a sender with no stable pane identity', () => {
    seedSupervisor()
    expect(() =>
      validateUpperReport({ db, payload: validPayload(), senderPaneKey: undefined })
    ).toThrowError(expect.objectContaining({ code: 'upper_report_forbidden' }))
  })

  it('rejects a sender pane without a supervisor roster record', () => {
    expect(() =>
      validateUpperReport({ db, payload: validPayload(), senderPaneKey: 'tab_sup:leaf_sup' })
    ).toThrowError(expect.objectContaining({ code: 'upper_report_forbidden' }))
  })

  it('rejects a sender whose roster sits in a different Run', () => {
    const otherRun = db.createRun({
      objective: 'other run',
      coordinatorHandle: 'term_other',
      coordinatorPaneKey: 'tab_other:leaf_other'
    })
    seedSupervisor({ runId: otherRun.id })
    expect(() =>
      validateUpperReport({ db, payload: validPayload(), senderPaneKey: 'tab_sup:leaf_sup' })
    ).toThrowError(expect.objectContaining({ code: 'upper_report_forbidden' }))
  })

  it('rejects a sender whose roster record is not a supervisor', () => {
    seedSupervisor({ role: 'relay', kind: 'worker' })
    expect(() =>
      validateUpperReport({ db, payload: validPayload(), senderPaneKey: 'tab_sup:leaf_sup' })
    ).toThrowError(expect.objectContaining({ code: 'upper_report_forbidden' }))
  })

  it('rejects a sender whose supervisor record is inactive', () => {
    const roster = seedSupervisor()
    db.deactivateRoleRoster(roster.id)
    expect(() =>
      validateUpperReport({ db, payload: validPayload(), senderPaneKey: 'tab_sup:leaf_sup' })
    ).toThrowError(expect.objectContaining({ code: 'upper_report_forbidden' }))
  })
})
