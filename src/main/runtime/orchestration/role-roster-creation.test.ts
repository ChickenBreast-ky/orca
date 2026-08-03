import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { deriveRoleRosterKind, recordCreatedRoleRoster } from './role-roster-creation'

describe('role roster creation input', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  it('derives the coarse kind from the role string', () => {
    expect(deriveRoleRosterKind('coordinator')).toBe('coordinator')
    expect(deriveRoleRosterKind('supervisor')).toBe('supervisor')
    expect(deriveRoleRosterKind('super-supervisor')).toBe('supervisor')
    expect(deriveRoleRosterKind('worker')).toBe('worker')
    expect(deriveRoleRosterKind('relay')).toBe('worker')
    expect(deriveRoleRosterKind('reviewer')).toBe('worker')
  })

  it('records a roster row with the handle cached as last_seen_handle only', () => {
    const d = createDb()
    const row = recordCreatedRoleRoster({
      db: d,
      input: {
        role: 'relay',
        project: 'orca',
        board: 'roster',
        runId: 'run_1',
        parentRole: 'supervisor',
        reportsTo: 'supervisor'
      },
      pane: 'tab_1:leaf_1',
      terminalHandle: 'term_relay',
      worktree: 'repo::wt',
      title: 'Relay'
    })
    expect(row.role).toBe('relay')
    expect(row.kind).toBe('worker')
    expect(row.run_id).toBe('run_1')
    expect(row.parent_role).toBe('supervisor')
    expect(row.reports_to).toBe('supervisor')
    expect(row.last_seen_handle).toBe('term_relay')
    expect(row.terminal_id).toBe('term_relay')
    expect(row.status).toBe('active')
  })

  it('falls back to the default Run id when the input omits one', () => {
    const d = createDb()
    const row = recordCreatedRoleRoster({
      db: d,
      input: { role: 'worker', project: 'orca', board: 'roster' },
      pane: 'tab_1:leaf_2',
      terminalHandle: 'term_worker',
      defaultRunId: 'run_default'
    })
    expect(row.run_id).toBe('run_default')
  })

  it('refuses to record without any Run id', () => {
    const d = createDb()
    expect(() =>
      recordCreatedRoleRoster({
        db: d,
        input: { role: 'worker', project: 'orca', board: 'roster' },
        pane: 'tab_1:leaf_3',
        terminalHandle: 'term_worker'
      })
    ).toThrowError(/Run id/)
    expect(d.listRoleRosters()).toHaveLength(0)
  })

  it('reuses the existing active row on a retry with the same identity and pane', () => {
    const d = createDb()
    const first = recordCreatedRoleRoster({
      db: d,
      input: { role: 'supervisor', project: 'orca', board: 'roster', runId: 'run_1' },
      pane: 'tab_1:leaf_1',
      terminalHandle: 'term_first'
    })
    const second = recordCreatedRoleRoster({
      db: d,
      input: { role: 'supervisor', project: 'orca', board: 'roster', runId: 'run_1' },
      pane: 'tab_1:leaf_1',
      terminalHandle: 'term_retry'
    })
    const rows = d.listRoleRosters({ status: 'active' })
    expect(rows).toHaveLength(1)
    expect(second.id).toBe(first.id)
    expect(rows[0].last_seen_handle).toBe('term_retry')
    expect(rows[0].terminal_id).toBe('term_retry')
  })

  it('rejects a second active record when a different pane already holds the identity', () => {
    const d = createDb()
    recordCreatedRoleRoster({
      db: d,
      input: { role: 'supervisor', project: 'orca', board: 'roster', runId: 'run_1' },
      pane: 'tab_1:leaf_1',
      terminalHandle: 'term_first'
    })
    expect(() =>
      recordCreatedRoleRoster({
        db: d,
        input: { role: 'supervisor', project: 'orca', board: 'roster', runId: 'run_1' },
        pane: 'tab_2:leaf_9',
        terminalHandle: 'term_second'
      })
    ).toThrowError(/already active/)
    expect(d.listRoleRosters({ status: 'active' })).toHaveLength(1)
  })

  it('rejects an explicit Run id that conflicts with the actual Run', () => {
    const d = createDb()
    expect(() =>
      recordCreatedRoleRoster({
        db: d,
        input: { role: 'worker', project: 'orca', board: 'roster', runId: 'run_other' },
        pane: 'tab_1:leaf_4',
        terminalHandle: 'term_worker',
        defaultRunId: 'run_actual'
      })
    ).toThrowError(/conflicts/)
    expect(d.listRoleRosters()).toHaveLength(0)
  })
})
