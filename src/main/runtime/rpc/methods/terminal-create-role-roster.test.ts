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
    await method.handler(
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
    )
    const rows = db!.listRoleRosters()
    expect(rows).toHaveLength(1)
    expect(rows[0].role).toBe('supervisor')
    expect(rows[0].kind).toBe('supervisor')
    expect(rows[0].reports_to).toBe('super-supervisor')
    expect(rows[0].pane).toBe('tab_1:leaf_1')
    expect(rows[0].run_id).toBe('run_1')
    expect(rows[0].last_seen_handle).toBe('term_new')
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
    await method.handler(
      method.params!.parse({ worktree: 'id:repo::wt', command: 'pwsh' }),
      { runtime } as unknown as RpcContext,
      vi.fn()
    )
    expect(db!.listRoleRosters()).toHaveLength(0)
  })

  it('skips the roster write when the fresh terminal has no resolvable pane', async () => {
    const { method, runtime } = setup({ pane: null })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await method.handler(
      method.params!.parse({
        worktree: 'id:repo::wt',
        roleRoster: { role: 'worker', project: 'orca', board: 'roster', runId: 'run_1' }
      }),
      { runtime } as unknown as RpcContext,
      vi.fn()
    )
    expect(db!.listRoleRosters()).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[role-roster]'), expect.anything())
    warn.mockRestore()
  })

  it('records only one active row when the same create is retried', async () => {
    const { method, runtime } = setup()
    const params = method.params!.parse({
      worktree: 'id:repo::wt',
      clientMutationId: 'mut_1',
      roleRoster: { role: 'supervisor', project: 'orca', board: 'roster', runId: 'run_1' }
    })
    await method.handler(params, { runtime } as unknown as RpcContext, vi.fn())
    await method.handler(params, { runtime } as unknown as RpcContext, vi.fn())
    const rows = db!.listRoleRosters({ status: 'active' })
    expect(rows).toHaveLength(1)
    expect(() =>
      db!.resolveActiveRoleRosterByRole({
        project: 'orca',
        board: 'roster',
        role: 'supervisor',
        runId: 'run_1'
      })
    ).not.toThrow()
  })

  it('does not fail terminal.create when the roster write itself fails', async () => {
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
    )) as { terminal: { handle: string } }
    expect(result.terminal.handle).toBe(terminal.handle)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[role-roster]'), expect.anything())
    warn.mockRestore()
  })
})
