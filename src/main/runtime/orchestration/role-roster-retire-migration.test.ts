import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import type { RoleRosterRow } from './types'

// Why: card 8 — the retired status widens a CHECK constraint, which SQLite can
// only do by rebuilding the table. The rebuild must carry every existing row
// forward with its stable pane, run_id, and last_seen_handle intact.
describe('role roster retired-status migration', () => {
  let db: OrchestrationDb | undefined
  let tempDir: string | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  function seedPreRetireDb(): string {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-db-migrate-v24-'))
    const dbPath = join(tempDir, 'test.db')
    const seeded = new OrchestrationDb(dbPath)
    seeded.close()

    // Why: rebuild role_roster with the pre-card-8 CHECK constraint and pin
    // user_version=23 so only the v24 migrate block can widen it.
    const raw = new Database(dbPath)
    raw.exec('DROP TABLE IF EXISTS role_roster')
    raw.exec(`
      CREATE TABLE role_roster (
        id                  TEXT PRIMARY KEY,
        terminal_id         TEXT,
        pane                TEXT NOT NULL,
        worktree            TEXT,
        project             TEXT NOT NULL,
        board               TEXT NOT NULL,
        role                TEXT NOT NULL,
        run_id              TEXT NOT NULL,
        parent_role         TEXT,
        reports_to          TEXT,
        kind                TEXT NOT NULL DEFAULT 'worker'
          CHECK(kind IN ('coordinator', 'worker', 'supervisor')),
        model               TEXT,
        status              TEXT NOT NULL DEFAULT 'active'
          CHECK(status IN ('active', 'inactive')),
        title               TEXT,
        can_dispatch        INTEGER NOT NULL DEFAULT 0,
        can_commit          INTEGER NOT NULL DEFAULT 0,
        can_message_super   INTEGER NOT NULL DEFAULT 0,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_handle    TEXT
      );
    `)
    raw
      .prepare(
        `INSERT INTO role_roster (
           id, terminal_id, pane, worktree, project, board, role, run_id,
           parent_role, reports_to, kind, model, status, title,
           can_dispatch, can_commit, can_message_super, last_seen_handle
         ) VALUES
           ('roster_keep_active', 'term_1', 'tab_1:leaf_1', '/wt', 'proj', 'board_a',
            'supervisor', 'run_1', NULL, NULL, 'supervisor', 'opus', 'active', 'Super',
            1, 1, 1, 'term_super_old'),
           ('roster_keep_inactive', NULL, 'tab_2:leaf_2', NULL, 'proj', 'board_a',
            'worker', 'run_1', 'supervisor', 'supervisor', 'worker', NULL, 'inactive', NULL,
            0, 0, 0, 'term_worker_old')`
      )
      .run()
    raw.pragma('user_version = 23')
    raw.close()
    return dbPath
  }

  it('preserves existing rows, pane, run_id, and last_seen_handle across the rebuild', () => {
    const dbPath = seedPreRetireDb()
    const d = new OrchestrationDb(dbPath)
    db = d

    const rows = d.listRoleRosters()
    expect(rows.map((row) => row.id).sort()).toEqual(['roster_keep_active', 'roster_keep_inactive'])
    const active = d.getRoleRoster('roster_keep_active') as RoleRosterRow
    expect(active.status).toBe('active')
    expect(active.pane).toBe('tab_1:leaf_1')
    expect(active.run_id).toBe('run_1')
    expect(active.last_seen_handle).toBe('term_super_old')
    expect(active.kind).toBe('supervisor')
    expect(active.can_dispatch).toBe(1)
    const inactive = d.getRoleRoster('roster_keep_inactive') as RoleRosterRow
    expect(inactive.status).toBe('inactive')
    expect(inactive.last_seen_handle).toBe('term_worker_old')
    expect(inactive.reports_to).toBe('supervisor')
  })

  it('accepts the retired status only after the migration widens the CHECK constraint', () => {
    const dbPath = seedPreRetireDb()
    const d = new OrchestrationDb(dbPath)
    db = d

    expect(d.retireRoleRoster('roster_keep_active')?.status).toBe('retired')
    expect(d.getRoleRoster('roster_keep_active')?.last_seen_handle).toBe('term_super_old')
    expect(d.listRoleRosters({ status: 'retired' }).map((row) => row.id)).toEqual([
      'roster_keep_active'
    ])
    expect(d.listRoleRosters({ status: 'active' })).toEqual([])
  })

  it('keeps the identity and pane indexes after the rebuild', () => {
    const dbPath = seedPreRetireDb()
    const d = new OrchestrationDb(dbPath)
    db = d

    const sqlite = (d as unknown as { db: InstanceType<typeof Database> }).db
    const indexes = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'role_roster'`)
      .all() as { name: string }[]
    const names = indexes.map((index) => index.name)
    expect(names).toContain('idx_role_roster_identity')
    expect(names).toContain('idx_role_roster_pane')
  })
})
