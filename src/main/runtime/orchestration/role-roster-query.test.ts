import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { OrchestrationError } from './orchestration-error'
import {
  listRoleRosterMembers,
  resolveRoleRosterMember,
  showRoleRosterMember,
  summarizeRoleRoster,
  type RoleRosterQueryRuntime
} from './role-roster-query'

// Why: card 3 — roster queries must resolve handles live from the stable
// pane, fail explicitly on zero/ambiguous candidates, and never guess model
// or liveness from a stored handle or title.
describe('role roster query', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  function stubRuntime(overrides?: {
    handles?: Record<string, string | null>
    facts?: Record<string, { state: string | null; model: string | null }>
  }): RoleRosterQueryRuntime {
    return {
      resolveCurrentPaneHandle: (paneKey) => {
        if (overrides?.handles && paneKey in overrides.handles) {
          return overrides.handles[paneKey]
        }
        return null
      },
      getPaneFacts: (paneKey) => overrides?.facts?.[paneKey] ?? null
    }
  }

  function seedMember(
    d: OrchestrationDb,
    overrides?: Partial<Parameters<OrchestrationDb['createRoleRoster']>[0]>
  ) {
    return d.createRoleRoster({
      pane: 'tab_1:leaf_1',
      project: 'proj',
      board: 'board_a',
      role: 'worker',
      runId: 'run_1',
      ...overrides
    })
  }

  it('lists members with live handle, lifecycle, and runtime model', () => {
    const d = createDb()
    seedMember(d, { pane: 'tab_1:leaf_live', lastSeenHandle: 'term_old', model: 'stored-model' })
    seedMember(d, { pane: 'tab_1:leaf_dead', role: 'reviewer' })
    const runtime = stubRuntime({
      handles: { 'tab_1:leaf_live': 'term_new' },
      facts: { 'tab_1:leaf_live': { state: 'working', model: 'runtime-model' } }
    })
    const members = listRoleRosterMembers({ db: d, runtime })
    expect(members).toHaveLength(2)
    const live = members.find((member) => member.pane === 'tab_1:leaf_live')
    expect(live?.currentHandle).toBe('term_new')
    expect(live?.live).toBe(true)
    expect(live?.lifecycle).toBe('active')
    expect(live?.model).toBe('runtime-model')
    expect(live?.agentState).toBe('working')
    const dead = members.find((member) => member.pane === 'tab_1:leaf_dead')
    expect(dead?.currentHandle).toBeNull()
    expect(dead?.lifecycle).toBe('stale')
    expect(dead?.cleanupCandidate).toBe(true)
    expect(dead?.model).toBeNull()
  })

  it('treats a resolver throw as no live terminal instead of failing', () => {
    const d = createDb()
    seedMember(d)
    const runtime: RoleRosterQueryRuntime = {
      resolveCurrentPaneHandle: () => {
        throw new Error('terminal_not_found')
      }
    }
    const members = listRoleRosterMembers({ db: d, runtime })
    expect(members[0].live).toBe(false)
    expect(members[0].lifecycle).toBe('stale')
  })

  it('does not refresh the handle cache on list, only on single-candidate show/resolve', () => {
    const d = createDb()
    const row = seedMember(d, { lastSeenHandle: 'term_A' })
    const runtime = stubRuntime({ handles: { 'tab_1:leaf_1': 'term_B' } })
    listRoleRosterMembers({ db: d, runtime })
    expect(d.getRoleRoster(row.id)?.last_seen_handle).toBe('term_A')
    const shown = showRoleRosterMember({
      db: d,
      runtime,
      identity: { project: 'proj', board: 'board_a', role: 'worker' }
    })
    expect(shown.currentHandle).toBe('term_B')
    expect(shown.handleRefreshed).toBe(true)
    expect(d.getRoleRoster(row.id)?.last_seen_handle).toBe('term_B')
  })

  it('fails explicitly when no active candidate exists', () => {
    const d = createDb()
    seedMember(d, { role: 'worker' })
    d.deactivateRoleRoster(d.listRoleRosters()[0].id)
    try {
      showRoleRosterMember({
        db: d,
        runtime: stubRuntime(),
        identity: { project: 'proj', board: 'board_a', role: 'worker' }
      })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(OrchestrationError)
      expect((error as OrchestrationError).code).toBe('role_roster_not_found')
    }
  })

  it('fails explicitly on two active candidates instead of auto-selecting', () => {
    const d = createDb()
    seedMember(d, { pane: 'tab_1:leaf_1' })
    seedMember(d, { pane: 'tab_2:leaf_2' })
    try {
      showRoleRosterMember({
        db: d,
        runtime: stubRuntime(),
        identity: { project: 'proj', board: 'board_a', role: 'worker' }
      })
      expect.unreachable()
    } catch (error) {
      expect((error as OrchestrationError).code).toBe('role_roster_ambiguous')
    }
  })

  it('scopes identity by Run when a runId is given', () => {
    const d = createDb()
    seedMember(d, { pane: 'tab_1:leaf_1', runId: 'run_1' })
    seedMember(d, { pane: 'tab_2:leaf_2', runId: 'run_2' })
    const shown = showRoleRosterMember({
      db: d,
      runtime: stubRuntime(),
      identity: { project: 'proj', board: 'board_a', role: 'worker', runId: 'run_2' }
    })
    expect(shown.pane).toBe('tab_2:leaf_2')
  })

  it('resolve reports a null handle without guessing when the pane is dead', () => {
    const d = createDb()
    seedMember(d, { lastSeenHandle: 'term_cached', title: 'term_cached worker' })
    const { member } = resolveRoleRosterMember({
      db: d,
      runtime: stubRuntime(),
      identity: { project: 'proj', board: 'board_a', role: 'worker' }
    })
    expect(member.currentHandle).toBeNull()
    expect(member.live).toBe(false)
    expect(member.lastSeenHandle).toBe('term_cached')
  })

  it('summary separates live supervisors, settled workers, and cleanup candidates', () => {
    const d = createDb()
    seedMember(d, { pane: 'tab_1:leaf_sup', role: 'supervisor', kind: 'supervisor' })
    seedMember(d, { pane: 'tab_1:leaf_w1', role: 'worker' })
    const settled = seedMember(d, { pane: 'tab_1:leaf_w2', role: 'worker' })
    seedMember(d, { pane: 'tab_1:leaf_w3', role: 'worker' })
    d.deactivateRoleRoster(settled.id)
    const runtime = stubRuntime({
      handles: { 'tab_1:leaf_sup': 'term_sup', 'tab_1:leaf_w1': 'term_w1' }
    })
    const summary = summarizeRoleRoster({ db: d, runtime })
    expect(summary.activeSupervisors).toEqual({ count: 1, roles: ['supervisor'] })
    expect(summary.workers).toEqual({ live: 1, stale: 1, inactive: 1, retired: 0 })
    expect(summary.totals).toEqual({ active: 2, stale: 1, inactive: 1, retired: 0 })
    const candidateLifecycles = summary.cleanupCandidates.map((c) => c.lifecycle).sort()
    expect(candidateLifecycles).toEqual(['inactive', 'stale'])
  })

  it('never fills model from title or stored handle', () => {
    const d = createDb()
    seedMember(d, { title: 'claude opus worker', lastSeenHandle: 'term_x' })
    const members = listRoleRosterMembers({ db: d, runtime: stubRuntime() })
    expect(members[0].model).toBeNull()
  })

  it('filters by exact worktree selector or resolved worktree id', () => {
    const d = createDb()
    seedMember(d, { pane: 'tab_1:leaf_1', worktree: 'repo::wt' })
    seedMember(d, { pane: 'tab_2:leaf_2', worktree: '/raw/folder-selector' })
    const runtime = stubRuntime()
    expect(
      listRoleRosterMembers({ db: d, runtime, filter: { worktreeId: 'repo::wt' } })
    ).toHaveLength(1)
    expect(
      listRoleRosterMembers({
        db: d,
        runtime,
        filter: { worktree: '/raw/folder-selector', worktreeId: 'repo::other' }
      })
    ).toHaveLength(1)
    expect(
      listRoleRosterMembers({ db: d, runtime, filter: { worktree: 'repo::nope' } })
    ).toHaveLength(0)
  })
})
