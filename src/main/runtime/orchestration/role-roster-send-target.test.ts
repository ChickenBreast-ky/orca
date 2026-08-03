import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { resolveRoleRosterSendTarget } from './role-roster-send-target'

// Why: card 4 — send targeting must resolve the current handle from the
// stable pane every time, fail closed with structured codes on every
// ambiguity class, and never retry last_seen_handle.
describe('resolveRoleRosterSendTarget', () => {
  let db: OrchestrationDb

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })

  afterEach(() => db.close())

  const identity = { project: 'proj', board: 'board_a', role: 'supervisor', runId: 'run_1' }

  function seed(overrides?: Partial<Parameters<OrchestrationDb['createRoleRoster']>[0]>) {
    return db.createRoleRoster({
      pane: 'tab_1:leaf_1',
      project: identity.project,
      board: identity.board,
      role: identity.role,
      runId: identity.runId,
      ...overrides
    })
  }

  const resolving = (handle: string) => () => handle

  it('resolves the current handle from the pane and refreshes a stale cache', () => {
    const roster = seed({ lastSeenHandle: 'term_A' })
    const target = resolveRoleRosterSendTarget({
      db,
      identity,
      resolveCurrentPaneHandle: resolving('term_B')
    })
    expect(target.handle).toBe('term_B')
    expect(target.handleRefreshed).toBe(true)
    expect(db.getRoleRoster(roster.id)?.last_seen_handle).toBe('term_B')
  })

  it('keeps the roster record across an A-to-B remint and resolves B only', () => {
    const roster = seed({ lastSeenHandle: 'term_A' })
    const target = resolveRoleRosterSendTarget({
      db,
      identity,
      resolveCurrentPaneHandle: resolving('term_B')
    })
    expect(target.roster.id).toBe(roster.id)
    expect(target.handle).toBe('term_B')
  })

  it('fails closed on zero candidates', () => {
    expect(() =>
      resolveRoleRosterSendTarget({ db, identity, resolveCurrentPaneHandle: resolving('term_B') })
    ).toThrowError(expect.objectContaining({ code: 'role_roster_not_found' }))
  })

  it('fails closed on two or more active candidates without auto-selecting', () => {
    seed({ pane: 'tab_1:leaf_1' })
    seed({ pane: 'tab_2:leaf_2' })
    expect(() =>
      resolveRoleRosterSendTarget({ db, identity, resolveCurrentPaneHandle: resolving('term_B') })
    ).toThrowError(expect.objectContaining({ code: 'role_roster_ambiguous' }))
  })

  it('distinguishes an unresolved pane from a runtime failure', () => {
    seed()
    expect(() =>
      resolveRoleRosterSendTarget({
        db,
        identity,
        resolveCurrentPaneHandle: () => {
          throw new Error('terminal_not_found')
        }
      })
    ).toThrowError(expect.objectContaining({ code: 'role_roster_pane_unresolved' }))
    expect(() =>
      resolveRoleRosterSendTarget({
        db,
        identity,
        resolveCurrentPaneHandle: () => {
          throw new Error('ssh connection lost')
        }
      })
    ).toThrowError(expect.objectContaining({ code: 'role_roster_runtime_disconnected' }))
  })

  it('fails closed when the handle changes between resolve and send', () => {
    seed({ lastSeenHandle: 'term_A' })
    const handles = ['term_A', 'term_B']
    expect(() =>
      resolveRoleRosterSendTarget({
        db,
        identity,
        resolveCurrentPaneHandle: () => handles.shift() ?? 'term_B'
      })
    ).toThrowError(expect.objectContaining({ code: 'role_roster_handle_changed' }))
  })

  it('never retries the cached last_seen_handle after a resolve failure', () => {
    const roster = seed({ lastSeenHandle: 'term_cached' })
    expect(() =>
      resolveRoleRosterSendTarget({
        db,
        identity,
        resolveCurrentPaneHandle: () => {
          throw new Error('terminal_not_found')
        }
      })
    ).toThrowError(expect.objectContaining({ code: 'role_roster_pane_unresolved' }))
    expect(db.getRoleRoster(roster.id)?.last_seen_handle).toBe('term_cached')
  })
})
