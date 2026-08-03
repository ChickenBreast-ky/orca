import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { isReverseReportMessage, validateReverseReport } from './reverse-report-validation'

// Why: card 7 — the structured reverse report envelope (superReply=true)
// must re-prove the sender supervisor authority and target Run validity;
// every gap fails closed before a message can cross a Run boundary.
describe('reverse report validation', () => {
  let db: OrchestrationDb
  let runProjId: string
  let runSuperId: string

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
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
  })

  afterEach(() => db.close())

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

  function validPayload(overrides?: Record<string, unknown>) {
    return {
      superReply: true,
      targetRunId: runProjId,
      reply: 'card 7 ack',
      ...overrides
    }
  }

  it('opts in only for type=status with superReply=true', () => {
    expect(isReverseReportMessage('status', { superReply: true })).toBe(true)
    expect(isReverseReportMessage('worker_done', { superReply: true })).toBe(false)
    expect(isReverseReportMessage('status', { superReply: 1 })).toBe(false)
    expect(isReverseReportMessage('status', { superReply: false })).toBe(false)
    expect(isReverseReportMessage('status', null)).toBe(false)
  })

  it('accepts an honest reply from the super supervisor pane', () => {
    seedSuperSupervisor()
    expect(
      validateReverseReport({
        db,
        payload: validPayload(),
        senderPaneKey: 'tab_super:leaf_super'
      })
    ).toEqual({ sourceRunId: runSuperId, targetRunId: runProjId })
  })

  it('matches the sender pane by stable leaf after a tab break-out', () => {
    const leaf = '22222222-2222-4222-8222-222222222222'
    seedSuperSupervisor({ pane: `tab_super:${leaf}` })
    expect(
      validateReverseReport({
        db,
        payload: validPayload(),
        senderPaneKey: `tab_breakout:${leaf}`
      })
    ).toEqual({ sourceRunId: runSuperId, targetRunId: runProjId })
  })
  it('fails closed when superReply or targetRunId is malformed', () => {
    seedSuperSupervisor()
    expect(() =>
      validateReverseReport({
        db,
        payload: validPayload({ superReply: false }),
        senderPaneKey: 'tab_super:leaf_super'
      })
    ).toThrowError(expect.objectContaining({ code: 'reverse_report_malformed' }))
    expect(() =>
      validateReverseReport({
        db,
        payload: validPayload({ targetRunId: '' }),
        senderPaneKey: 'tab_super:leaf_super'
      })
    ).toThrowError(expect.objectContaining({ code: 'reverse_report_malformed' }))
  })

  it('rejects a sender with no stable pane identity', () => {
    seedSuperSupervisor()
    expect(() =>
      validateReverseReport({ db, payload: validPayload(), senderPaneKey: undefined })
    ).toThrowError(expect.objectContaining({ code: 'reverse_report_forbidden' }))
  })

  it('rejects a sender pane without a supervisor roster record', () => {
    expect(() =>
      validateReverseReport({
        db,
        payload: validPayload(),
        senderPaneKey: 'tab_super:leaf_super'
      })
    ).toThrowError(expect.objectContaining({ code: 'reverse_report_forbidden' }))
  })

  it('rejects a sender whose pane has no roster record at all', () => {
    seedSuperSupervisor()
    expect(() =>
      validateReverseReport({
        db,
        payload: validPayload(),
        senderPaneKey: 'tab_nobody:leaf_nobody'
      })
    ).toThrowError(expect.objectContaining({ code: 'reverse_report_forbidden' }))
  })

  it('fails closed when the sender pane has supervisor rosters in multiple Runs', () => {
    const otherRun = db.createRun({
      objective: 'other',
      coordinatorHandle: 'term_other',
      coordinatorPaneKey: 'tab_other:leaf_other'
    })
    seedSuperSupervisor({ runId: runSuperId })
    // Why: same pane, two Runs — ambiguous, fail closed
    db.createRoleRoster({
      pane: 'tab_super:leaf_super',
      project: 'proj',
      board: 'board_a',
      role: 'super_supervisor_b',
      runId: otherRun.id,
      kind: 'supervisor'
    })
    expect(() =>
      validateReverseReport({
        db,
        payload: validPayload(),
        senderPaneKey: 'tab_super:leaf_super'
      })
    ).toThrowError(expect.objectContaining({ code: 'reverse_report_forbidden' }))
  })

  // Why: card 7 R3 — two supervisor rosters for the same pane in the SAME
  // Run are just as ambiguous; deduplicating by run_id would silently accept.
  it('fails closed when the sender pane has two supervisor rosters in the same Run', () => {
    seedSuperSupervisor()
    // Why: second supervisor roster for the same pane in the same Run
    db.createRoleRoster({
      pane: 'tab_super:leaf_super',
      project: 'proj',
      board: 'board_a',
      role: 'super_supervisor_extra',
      runId: runSuperId,
      kind: 'supervisor'
    })
    expect(() =>
      validateReverseReport({
        db,
        payload: validPayload(),
        senderPaneKey: 'tab_super:leaf_super'
      })
    ).toThrowError(expect.objectContaining({ code: 'reverse_report_forbidden' }))
  })

  it('rejects a sender whose roster record is not a supervisor', () => {
    seedSuperSupervisor({ kind: 'worker', role: 'relay' })
    expect(() =>
      validateReverseReport({
        db,
        payload: validPayload(),
        senderPaneKey: 'tab_super:leaf_super'
      })
    ).toThrowError(expect.objectContaining({ code: 'reverse_report_forbidden' }))
  })

  it('rejects a sender whose supervisor record is inactive', () => {
    const roster = seedSuperSupervisor()
    db.deactivateRoleRoster(roster.id)
    expect(() =>
      validateReverseReport({
        db,
        payload: validPayload(),
        senderPaneKey: 'tab_super:leaf_super'
      })
    ).toThrowError(expect.objectContaining({ code: 'reverse_report_forbidden' }))
  })

  it('rejects a target Run that does not exist', () => {
    seedSuperSupervisor()
    expect(() =>
      validateReverseReport({
        db,
        payload: validPayload({ targetRunId: 'run_does_not_exist' }),
        senderPaneKey: 'tab_super:leaf_super'
      })
    ).toThrowError(expect.objectContaining({ code: 'reverse_report_target_run_invalid' }))
  })

  it('rejects a target Run that is the same as the source Run', () => {
    seedSuperSupervisor()
    expect(() =>
      validateReverseReport({
        db,
        payload: validPayload({ targetRunId: runSuperId }),
        senderPaneKey: 'tab_super:leaf_super'
      })
    ).toThrowError(expect.objectContaining({ code: 'reverse_report_same_run' }))
  })
})
