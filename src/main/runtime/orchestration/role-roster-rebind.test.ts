import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { rebindRoleRosterMember, type RoleRosterRebindResult } from './role-roster-rebind'
import type { RoleRosterRow } from './types'

// Why: rebind is the official way to move an active role identity to a new
// pane without DB surgery. It must be fail-closed on identity ambiguity,
// stale old-pane views, target-pane conflicts (cross-identity!), and retired
// records, while staying idempotent for same-pane no-op calls.
describe('role roster rebind', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  function seedRun(d: OrchestrationDb): string {
    return d.createRun({
      objective: 'rebind test',
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
      role: 'worker',
      runId,
      lastSeenHandle: 'term_old',
      ...overrides
    })
  }

  function rebind(
    d: OrchestrationDb,
    runId: string,
    overrides?: Partial<Parameters<typeof rebindRoleRosterMember>[0]>
  ): RoleRosterRebindResult {
    return rebindRoleRosterMember({
      db: d,
      identity: {
        project: 'proj',
        board: 'board_a',
        role: 'worker',
        fromPane: 'tab_1:leaf_1',
        toPane: 'tab_2:leaf_2',
        runId
      },
      ...overrides
    })
  }

  // ── happy path ──

  it('moves the pane and keeps the record active with identity intact', () => {
    const d = createDb()
    const runId = seedRun(d)
    const roster = seedRoster(d, runId)

    const result = rebind(d, runId)

    expect(result.rebound).toBe(true)
    expect(result.blockers).toEqual([])
    expect(result.checklist.map((step) => [step.code, step.passed])).toEqual([
      ['single_active_candidate', true],
      ['old_pane_confirmed', true],
      ['new_pane_available', true],
      ['record_still_active', true]
    ])
    expect(result.member?.pane).toBe('tab_2:leaf_2')
    expect(result.member?.status).toBe('active')

    const stored = d.getRoleRoster(roster.id)
    expect(stored?.pane).toBe('tab_2:leaf_2')
    expect(stored?.status).toBe('active')
    expect(stored?.role).toBe('worker')
    expect(stored?.project).toBe('proj')
    expect(stored?.run_id).toBe(runId)
  })

  it('updates terminal_id and last_seen_handle when provided', () => {
    const d = createDb()
    const runId = seedRun(d)
    seedRoster(d, runId)

    const result = rebind(d, runId, {
      terminalId: 'term_new',
      lastSeenHandle: 'term_new_live'
    })

    expect(result.rebound).toBe(true)
    expect(result.member?.terminal_id).toBe('term_new')
    expect(result.member?.last_seen_handle).toBe('term_new_live')
  })

  it('preserves existing terminal_id and last_seen_handle when not provided', () => {
    const d = createDb()
    const runId = seedRun(d)
    seedRoster(d, runId, { terminalId: 'term_original', lastSeenHandle: 'term_original' })

    const result = rebind(d, runId)

    expect(result.rebound).toBe(true)
    expect(result.member?.terminal_id).toBe('term_original')
    expect(result.member?.last_seen_handle).toBe('term_original')
  })

  it('resolves the role on the new pane after rebind', () => {
    const d = createDb()
    const runId = seedRun(d)
    seedRoster(d, runId)

    rebind(d, runId)

    const onNew = d.resolveActiveRoleRosterByRole({
      project: 'proj',
      board: 'board_a',
      role: 'worker',
      runId
    })
    expect(onNew?.pane).toBe('tab_2:leaf_2')

    expect(
      d.resolveActiveRoleRoster({
        project: 'proj',
        board: 'board_a',
        role: 'worker',
        pane: 'tab_1:leaf_1',
        runId
      })
    ).toBeUndefined()
  })

  // ── idempotency ──

  it('is idempotent when rebinding to the same pane with no handle update (no write, success)', () => {
    const d = createDb()
    const runId = seedRun(d)
    const roster = seedRoster(d, runId)
    const before = d.getRoleRoster(roster.id)

    const result = rebindRoleRosterMember({
      db: d,
      identity: {
        project: 'proj',
        board: 'board_a',
        role: 'worker',
        fromPane: 'tab_1:leaf_1',
        toPane: 'tab_1:leaf_1',
        runId
      }
    })

    expect(result.rebound).toBe(true)
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings[0]).toContain('Idempotent')
    expect(result.blockers).toEqual([])
    expect(d.getRoleRoster(roster.id)).toEqual(before)
  })

  it('accepts an equivalent leaf-id pane as idempotent no-op', () => {
    const d = createDb()
    const runId = seedRun(d)
    const leaf = 'aaaaaaaa-1111-4111-8111-111111111111'
    seedRoster(d, runId, { pane: `tab_1:${leaf}` })

    const result = rebindRoleRosterMember({
      db: d,
      identity: {
        project: 'proj',
        board: 'board_a',
        role: 'worker',
        fromPane: `tab_1:${leaf}`,
        toPane: `tab_99:${leaf}`,
        runId
      }
    })

    expect(result.rebound).toBe(true)
    expect(result.warnings[0]).toContain('Idempotent')
  })

  it('refreshes terminal_id and last_seen_handle on same-pane rebind without moving the pane', () => {
    const d = createDb()
    const runId = seedRun(d)
    const roster = seedRoster(d, runId, {
      terminalId: 'term_dead',
      lastSeenHandle: 'term_dead'
    })

    const result = rebindRoleRosterMember({
      db: d,
      identity: {
        project: 'proj',
        board: 'board_a',
        role: 'worker',
        fromPane: 'tab_1:leaf_1',
        toPane: 'tab_1:leaf_1',
        runId
      },
      terminalId: 'term_new',
      lastSeenHandle: 'term_new_live'
    })

    expect(result.rebound).toBe(true)
    expect(result.warnings[0]).toContain('Handle cache refreshed')
    expect(result.member?.terminal_id).toBe('term_new')
    expect(result.member?.last_seen_handle).toBe('term_new_live')
    expect(result.member?.pane).toBe('tab_1:leaf_1')

    const stored = d.getRoleRoster(roster.id)
    expect(stored?.terminal_id).toBe('term_new')
    expect(stored?.last_seen_handle).toBe('term_new_live')
  })

  // ── identity blockers ──

  it('refuses when no active record exists for the identity', () => {
    const d = createDb()
    const runId = seedRun(d)

    const result = rebind(d, runId)

    expect(result.rebound).toBe(false)
    expect(result.blockers.map((b) => b.code)).toEqual(['single_active_candidate'])
    expect(result.member).toBeNull()
  })

  it('refuses when two active records hold the same identity (ambiguous)', () => {
    const d = createDb()
    const runId = seedRun(d)
    seedRoster(d, runId, { pane: 'tab_1:leaf_1' })
    seedRoster(d, runId, { pane: 'tab_2:leaf_2', lastSeenHandle: 'term_second' })

    const result = rebind(d, runId)

    expect(result.rebound).toBe(false)
    expect(result.blockers.map((b) => b.code)).toEqual(['single_active_candidate'])
  })

  // ── old-pane confirmation ──

  it('refuses when the given from-pane does not match the record pane', () => {
    const d = createDb()
    const runId = seedRun(d)
    const roster = seedRoster(d, runId, { pane: 'tab_1:leaf_1' })

    const result = rebindRoleRosterMember({
      db: d,
      identity: {
        project: 'proj',
        board: 'board_a',
        role: 'worker',
        fromPane: 'tab_9:leaf_9',
        toPane: 'tab_2:leaf_2',
        runId
      }
    })

    expect(result.rebound).toBe(false)
    expect(result.blockers.map((b) => b.code)).toEqual(['old_pane_confirmed'])
    expect(d.getRoleRoster(roster.id)?.pane).toBe('tab_1:leaf_1')
  })

  // ── cross-identity target-pane conflict (치명1 회귀) ──

  it('refuses to rebind onto a pane already held by a different role (cross-identity occupant)', () => {
    const d = createDb()
    const runId = seedRun(d)
    // Why: worker on source pane, a different active role on the target pane.
    seedRoster(d, runId, { pane: 'tab_1:leaf_1', role: 'worker' })
    seedRoster(d, runId, {
      pane: 'tab_2:leaf_2',
      role: 'reviewer',
      lastSeenHandle: 'term_reviewer'
    })

    const result = rebind(d, runId)

    expect(result.rebound).toBe(false)
    expect(result.blockers.map((b) => b.code)).toEqual(['new_pane_available'])
    expect(result.warnings[0]).toContain('reviewer')
  })

  it('refuses to move a supervisor onto a live worker pane (privilege escalation guard)', () => {
    const d = createDb()
    const runId = seedRun(d)
    // Why: the supervisor holds reverse/upper-report authority per-pane.
    // Moving it onto the worker pane would grant that authority to the worker.
    seedRoster(d, runId, {
      pane: 'tab_1:leaf_1',
      role: 'project-supervisor',
      kind: 'supervisor',
      lastSeenHandle: 'term_super'
    })
    seedRoster(d, runId, {
      pane: 'tab_2:leaf_2',
      role: 'worker',
      kind: 'worker',
      lastSeenHandle: 'term_worker'
    })

    const result = rebindRoleRosterMember({
      db: d,
      identity: {
        project: 'proj',
        board: 'board_a',
        role: 'project-supervisor',
        fromPane: 'tab_1:leaf_1',
        toPane: 'tab_2:leaf_2',
        runId
      }
    })

    expect(result.rebound).toBe(false)
    expect(result.blockers.map((b) => b.code)).toEqual(['new_pane_available'])
    expect(result.warnings[0]).toContain('worker')
    // Why: the supervisor record must stay on its original pane.
    expect(
      d.resolveActiveRoleRoster({
        project: 'proj',
        board: 'board_a',
        role: 'project-supervisor',
        pane: 'tab_1:leaf_1',
        runId
      })?.pane
    ).toBe('tab_1:leaf_1')
  })

  it('allows rebinding onto a pane whose prior occupant is retired (not active)', () => {
    const d = createDb()
    const runId = seedRun(d)
    seedRoster(d, runId, { pane: 'tab_1:leaf_1' })
    const retiredOccupant = seedRoster(d, runId, {
      pane: 'tab_2:leaf_2',
      lastSeenHandle: 'term_old_target'
    })
    d.retireRoleRoster(retiredOccupant.id)

    const result = rebind(d, runId)
    expect(result.rebound).toBe(true)
    expect(result.member?.pane).toBe('tab_2:leaf_2')
  })

  // ── retired / inactive record ──

  it('refuses to rebind a retired record (no resurrection)', () => {
    const d = createDb()
    const runId = seedRun(d)
    const roster = seedRoster(d, runId, { pane: 'tab_1:leaf_1' })
    d.retireRoleRoster(roster.id)

    const result = rebind(d, runId)

    expect(result.rebound).toBe(false)
    expect(result.blockers.map((b) => b.code)).toEqual(['single_active_candidate'])
    expect(d.getRoleRoster(roster.id)?.status).toBe('retired')
  })

  // ── after rebind, old pane is free ──

  it('frees the old pane after rebind so a new record can claim it', () => {
    const d = createDb()
    const runId = seedRun(d)
    seedRoster(d, runId, { pane: 'tab_1:leaf_1' })

    rebind(d, runId)

    const newRecord = d.ensureActiveRoleRoster({
      pane: 'tab_1:leaf_1',
      project: 'proj',
      board: 'board_a',
      role: 'replacement',
      runId
    })
    expect(newRecord.status).toBe('active')
    expect(newRecord.pane).toBe('tab_1:leaf_1')
  })

  // ── double rebind (sequential) ──

  it('allows a second rebind from the new pane to a third pane', () => {
    const d = createDb()
    const runId = seedRun(d)
    seedRoster(d, runId, { pane: 'tab_1:leaf_1' })

    const first = rebind(d, runId)
    expect(first.rebound).toBe(true)

    const second = rebindRoleRosterMember({
      db: d,
      identity: {
        project: 'proj',
        board: 'board_a',
        role: 'worker',
        fromPane: 'tab_2:leaf_2',
        toPane: 'tab_3:leaf_3',
        runId
      }
    })
    expect(second.rebound).toBe(true)
    expect(second.member?.pane).toBe('tab_3:leaf_3')
  })

  it('refuses a second rebind using the stale old pane', () => {
    const d = createDb()
    const runId = seedRun(d)
    seedRoster(d, runId, { pane: 'tab_1:leaf_1' })

    rebind(d, runId)

    const stale = rebind(d, runId)
    expect(stale.rebound).toBe(false)
    expect(stale.blockers.map((b) => b.code)).toEqual(['old_pane_confirmed'])
  })
})
