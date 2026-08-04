import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { OrchestrationDb } from '../../orchestration/db'
import { TERMINAL_METHODS } from './terminal'

// Why: card 2 — the real terminal create RPC path must leave an official
// role_roster record when role input is supplied (supervisor and relay
// terminals are plain `terminal create` calls with a role).
describe('terminal.create role roster registration', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function setup(options?: { pane?: string | null }) {
    db = new OrchestrationDb(':memory:')
    const terminal = { handle: 'term_new', worktreeId: 'repo::wt', title: null }
    const createTerminal = vi.fn(async () => terminal)
    const dedupeTerminalCreate = vi.fn(
      async (
        _clientIdentity: string,
        _worktree: string | undefined,
        _mutationId: string | undefined,
        _reconcileExisting: boolean,
        run: (worktree: string | undefined, handle: string | undefined) => Promise<typeof terminal>
      ) => run('id:repo::wt', undefined)
    )
    const getTerminalPaneKey = vi.fn(() =>
      options && 'pane' in options ? options.pane! : 'tab_1:leaf_1'
    )
    const runtime = {
      createTerminal,
      dedupeTerminalCreate,
      getTerminalPaneKey,
      getOrchestrationDb: () => db
    }
    const method = TERMINAL_METHODS.find((candidate) => candidate.name === 'terminal.create')
    if (!method) {
      throw new Error('terminal.create method missing')
    }
    return { method, runtime, terminal }
  }

  it('registers a supervisor terminal in the role roster', async () => {
    const { method, runtime } = setup()
    const result = (await method.handler(
      method.params!.parse({
        worktree: 'id:repo::wt',
        command: 'codex',
        roleRoster: {
          role: 'supervisor',
          project: 'orca',
          board: 'roster',
          runId: 'run_1',
          reportsTo: 'super-supervisor'
        }
      }),
      { runtime } as unknown as RpcContext,
      vi.fn()
    )) as {
      terminal: {
        warning?: string
        roleRoster?: {
          registered: boolean
          member?: {
            id: string
            pane: string
            project: string
            board: string
            role: string
            runId: string
            kind: string
            status: string
            reportsTo: string | null
            lastSeenHandle: string | null
          }
        }
      }
    }
    const rows = db!.listRoleRosters()
    expect(rows).toHaveLength(1)
    expect(rows[0].role).toBe('supervisor')
    expect(rows[0].kind).toBe('supervisor')
    expect(rows[0].reports_to).toBe('super-supervisor')
    expect(rows[0].pane).toBe('tab_1:leaf_1')
    expect(rows[0].run_id).toBe('run_1')
    expect(rows[0].last_seen_handle).toBe('term_new')
    expect(result.terminal.warning).toBeUndefined()
    expect(result.terminal.roleRoster?.registered).toBe(true)
    expect(result.terminal.roleRoster?.member).toMatchObject({
      id: rows[0].id,
      pane: 'tab_1:leaf_1',
      project: 'orca',
      board: 'roster',
      role: 'supervisor',
      runId: 'run_1',
      kind: 'supervisor',
      status: 'active',
      reportsTo: 'super-supervisor',
      lastSeenHandle: 'term_new'
    })
  })

  it('registers a relay terminal in the role roster', async () => {
    const { method, runtime } = setup()
    await method.handler(
      method.params!.parse({
        worktree: 'id:repo::wt',
        roleRoster: {
          role: 'relay',
          project: 'orca',
          board: 'roster',
          runId: 'run_1',
          parentRole: 'supervisor'
        }
      }),
      { runtime } as unknown as RpcContext,
      vi.fn()
    )
    const rows = db!.listRoleRosters()
    expect(rows).toHaveLength(1)
    expect(rows[0].role).toBe('relay')
    expect(rows[0].kind).toBe('worker')
    expect(rows[0].parent_role).toBe('supervisor')
  })

  it('leaves no roster record when role input is absent', async () => {
    const { method, runtime } = setup()
    const result = (await method.handler(
      method.params!.parse({ worktree: 'id:repo::wt', command: 'pwsh' }),
      { runtime } as unknown as RpcContext,
      vi.fn()
    )) as { terminal: { roleRoster?: unknown; warning?: string } }
    expect(db!.listRoleRosters()).toHaveLength(0)
    expect(result.terminal.roleRoster).toBeUndefined()
    expect(result.terminal.warning).toBeUndefined()
  })

  it('skips the roster write when the fresh terminal has no resolvable pane', async () => {
    const { method, runtime } = setup({ pane: null })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = (await method.handler(
      method.params!.parse({
        worktree: 'id:repo::wt',
        roleRoster: { role: 'worker', project: 'orca', board: 'roster', runId: 'run_1' }
      }),
      { runtime } as unknown as RpcContext,
      vi.fn()
    )) as {
      terminal: {
        handle: string
        warning?: string
        roleRoster?: { registered: boolean; error?: { code: string } }
      }
    }
    expect(db!.listRoleRosters()).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[role-roster]'), expect.anything())
    expect(result.terminal.handle).toBe('term_new')
    expect(result.terminal.roleRoster?.registered).toBe(false)
    expect(result.terminal.roleRoster?.error?.code).toBe('role_roster_pane_unresolved')
    expect(result.terminal.warning).toContain('role_roster_pane_unresolved')
    warn.mockRestore()
  })

  it('records only one active row when the same create is retried', async () => {
    const { method, runtime } = setup()
    const params = method.params!.parse({
      worktree: 'id:repo::wt',
      clientMutationId: 'mut_1',
      roleRoster: { role: 'supervisor', project: 'orca', board: 'roster', runId: 'run_1' }
    })
    const first = (await method.handler(params, { runtime } as unknown as RpcContext, vi.fn())) as {
      terminal: { roleRoster?: { registered: boolean; member?: { id: string } } }
    }
    const second = (await method.handler(
      params,
      { runtime } as unknown as RpcContext,
      vi.fn()
    )) as { terminal: { roleRoster?: { registered: boolean; member?: { id: string } } } }
    const rows = db!.listRoleRosters({ status: 'active' })
    expect(rows).toHaveLength(1)
    expect(first.terminal.roleRoster?.registered).toBe(true)
    expect(second.terminal.roleRoster?.registered).toBe(true)
    expect(second.terminal.roleRoster?.member?.id).toBe(first.terminal.roleRoster?.member?.id)
    expect(() =>
      db!.resolveActiveRoleRosterByRole({
        project: 'orca',
        board: 'roster',
        role: 'supervisor',
        runId: 'run_1'
      })
    ).not.toThrow()
  })

  it('reports an active identity conflict on the receipt instead of plain success', async () => {
    const { method, runtime } = setup()
    db!.ensureActiveRoleRoster({
      pane: 'tab_9:leaf_9',
      project: 'orca',
      board: 'roster',
      role: 'relay',
      runId: 'run_1'
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = (await method.handler(
      method.params!.parse({
        worktree: 'id:repo::wt',
        roleRoster: { role: 'relay', project: 'orca', board: 'roster', runId: 'run_1' }
      }),
      { runtime } as unknown as RpcContext,
      vi.fn()
    )) as {
      terminal: {
        handle: string
        warning?: string
        roleRoster?: { registered: boolean; error?: { code: string; message: string } }
      }
    }
    expect(result.terminal.handle).toBe('term_new')
    expect(result.terminal.roleRoster?.registered).toBe(false)
    expect(result.terminal.roleRoster?.error?.code).toBe('role_roster_conflict')
    expect(result.terminal.warning).toContain('role_roster_conflict')
    warn.mockRestore()
  })

  it('rejects role input without a run id as an explicit receipt error', async () => {
    const { method, runtime } = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = (await method.handler(
      method.params!.parse({
        worktree: 'id:repo::wt',
        roleRoster: { role: 'relay', project: 'orca', board: 'roster' }
      }),
      { runtime } as unknown as RpcContext,
      vi.fn()
    )) as {
      terminal: {
        handle: string
        warning?: string
        roleRoster?: { registered: boolean; error?: { code: string } }
      }
    }
    expect(result.terminal.handle).toBe('term_new')
    expect(result.terminal.roleRoster?.registered).toBe(false)
    expect(result.terminal.roleRoster?.error?.code).toBe('invalid_argument')
    expect(result.terminal.warning).toContain('invalid_argument')
    warn.mockRestore()
  })

  it('returns a partial receipt when the roster write itself fails', async () => {
    const { method, runtime, terminal } = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(db!, 'createRoleRoster').mockImplementation(() => {
      throw new Error('db locked')
    })
    const result = (await method.handler(
      method.params!.parse({
        worktree: 'id:repo::wt',
        roleRoster: { role: 'worker', project: 'orca', board: 'roster', runId: 'run_1' }
      }),
      { runtime } as unknown as RpcContext,
      vi.fn()
    )) as {
      terminal: {
        handle: string
        warning?: string
        roleRoster?: { registered: boolean; error?: { code: string; message: string } }
      }
    }
    expect(result.terminal.handle).toBe(terminal.handle)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[role-roster]'), expect.anything())
    expect(result.terminal.roleRoster?.registered).toBe(false)
    expect(result.terminal.roleRoster?.error?.code).toBe('role_roster_write_failed')
    expect(result.terminal.roleRoster?.error?.message).toContain('db locked')
    expect(result.terminal.warning).toContain('role_roster_write_failed')
    warn.mockRestore()
  })
})
