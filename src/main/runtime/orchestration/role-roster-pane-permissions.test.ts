import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import {
  lookupRoleRosterPanePermissions,
  type RoleRosterPaneHandleResolver
} from './role-roster-pane-permissions'

describe('lookupRoleRosterPanePermissions', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  function resolver(map: Record<string, string | null>): RoleRosterPaneHandleResolver {
    return (paneKey: string) => map[paneKey] ?? null
  }

  it('refreshes a stale last_seen_handle to the current runtime handle on reconnect', () => {
    const d = createDb()
    const row = d.createRoleRoster({
      pane: 'tab_1:leaf_1',
      project: 'proj',
      board: 'board_a',
      role: 'worker',
      runId: 'run_1',
      lastSeenHandle: 'term_A',
      canDispatch: true,
      canCommit: false,
      canMessageSuper: true
    })

    // handle remints from A -> B after Orca restart/reconnect
    const result = lookupRoleRosterPanePermissions({
      db: d,
      rosterId: row.id,
      resolveCurrentPaneHandle: resolver({ 'tab_1:leaf_1': 'term_B' })
    })

    expect(result).toBeDefined()
    expect(result?.handleRefreshed).toBe(true)
    // same record preserved, only the cached handle moved A -> B
    expect(result?.roster.id).toBe(row.id)
    expect(result?.roster.last_seen_handle).toBe('term_B')
    expect(result?.roster.pane).toBe('tab_1:leaf_1')
    expect(result?.permissions.canDispatch).toBe(true)
    expect(result?.permissions.canCommit).toBe(false)
    expect(result?.permissions.canMessageSuper).toBe(true)

    // persisted: a fresh read shows the refreshed handle
    expect(d.getRoleRoster(row.id)?.last_seen_handle).toBe('term_B')
  })

  it('does not rewrite handle when it already matches', () => {
    const d = createDb()
    const row = d.createRoleRoster({
      pane: 'tab_1:leaf_1',
      project: 'proj',
      board: 'board_a',
      role: 'worker',
      runId: 'run_1',
      lastSeenHandle: 'term_A'
    })

    const result = lookupRoleRosterPanePermissions({
      db: d,
      rosterId: row.id,
      resolveCurrentPaneHandle: resolver({ 'tab_1:leaf_1': 'term_A' })
    })

    expect(result?.handleRefreshed).toBe(false)
    expect(result?.roster.last_seen_handle).toBe('term_A')
  })

  it('leaves handle untouched when no live runtime pane exists', () => {
    const d = createDb()
    const row = d.createRoleRoster({
      pane: 'tab_1:leaf_1',
      project: 'proj',
      board: 'board_a',
      role: 'worker',
      runId: 'run_1',
      lastSeenHandle: 'term_A'
    })

    const result = lookupRoleRosterPanePermissions({
      db: d,
      rosterId: row.id,
      resolveCurrentPaneHandle: resolver({ 'tab_1:leaf_1': null })
    })

    expect(result?.handleRefreshed).toBe(false)
    expect(result?.roster.last_seen_handle).toBe('term_A')
  })

  it('returns undefined for an unknown roster id', () => {
    const d = createDb()
    const result = lookupRoleRosterPanePermissions({
      db: d,
      rosterId: 'roster_missing',
      resolveCurrentPaneHandle: resolver({})
    })
    expect(result).toBeUndefined()
  })

  it('treats a throwing resolver (unknown pane) as no live pane and leaves the handle untouched', () => {
    const d = createDb()
    const row = d.createRoleRoster({
      pane: 'tab_1:leaf_1',
      project: 'proj',
      board: 'board_a',
      role: 'worker',
      runId: 'run_1',
      lastSeenHandle: 'term_A'
    })

    // Why: the runtime's resolveTerminalPane throws for unknown panes instead
    // of returning null; the lookup must absorb that, not crash.
    const result = lookupRoleRosterPanePermissions({
      db: d,
      rosterId: row.id,
      resolveCurrentPaneHandle: () => {
        throw new Error('unknown pane')
      }
    })

    expect(result).toBeDefined()
    expect(result?.handleRefreshed).toBe(false)
    expect(result?.roster.last_seen_handle).toBe('term_A')
    expect(d.getRoleRoster(row.id)?.last_seen_handle).toBe('term_A')
  })

  it('resolves through a stable-leaf matcher after pane break-out', () => {
    const d = createDb()
    const LEAF = '11111111-1111-1111-8111-111111111111'
    const row = d.createRoleRoster({
      pane: `tab_1:${LEAF}`,
      project: 'proj',
      board: 'board_a',
      role: 'worker',
      runId: 'run_1',
      lastSeenHandle: 'term_A'
    })

    // Why: the runtime adapter contract — the pane reminted to tab_2 after
    // break-out, and the resolver matches by stable leaf, not exact string.
    const result = lookupRoleRosterPanePermissions({
      db: d,
      rosterId: row.id,
      resolveCurrentPaneHandle: (paneKey) => (paneKey.endsWith(LEAF) ? 'term_B' : null)
    })

    expect(result?.handleRefreshed).toBe(true)
    expect(result?.roster.last_seen_handle).toBe('term_B')
    expect(result?.roster.pane).toBe(`tab_1:${LEAF}`)
  })

  it('does not refresh the handle of an inactive roster even when the pane is live', () => {
    const d = createDb()
    const row = d.createRoleRoster({
      pane: 'tab_1:leaf_1',
      project: 'proj',
      board: 'board_a',
      role: 'worker',
      runId: 'run_1',
      lastSeenHandle: 'term_A'
    })
    d.deactivateRoleRoster(row.id)

    const result = lookupRoleRosterPanePermissions({
      db: d,
      rosterId: row.id,
      resolveCurrentPaneHandle: resolver({ 'tab_1:leaf_1': 'term_B' })
    })

    expect(result?.handleRefreshed).toBe(false)
    expect(result?.roster.last_seen_handle).toBe('term_A')
  })

  it('refreshes a previously-null handle once the pane is live', () => {
    const d = createDb()
    const row = d.createRoleRoster({
      pane: 'tab_1:leaf_1',
      project: 'proj',
      board: 'board_a',
      role: 'worker',
      runId: 'run_1'
    })

    const result = lookupRoleRosterPanePermissions({
      db: d,
      rosterId: row.id,
      resolveCurrentPaneHandle: resolver({ 'tab_1:leaf_1': 'term_first' })
    })

    expect(result?.handleRefreshed).toBe(true)
    expect(result?.roster.last_seen_handle).toBe('term_first')
  })
})
