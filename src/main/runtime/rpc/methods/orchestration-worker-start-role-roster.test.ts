import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'

// Why: card 2 — the real worker-start RPC path must leave an official
// role_roster record for the ready worker when the coordinator supplies role
// input, keyed by the worker's stable pane and Run.
describe('orchestration worker-start role roster registration', () => {
  const coordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const workerPaneKey = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let runId: string

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    runId = db.createRun({
      objective: 'Role roster worker-start',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey
    }).id
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? coordinatorPaneKey : handle === 'term_worker' ? workerPaneKey : null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === 'term_worker' ? 'runtime_test:term_worker:1' : null
    )
    vi.spyOn(runtime, 'showTerminal').mockImplementation(async (handle) => {
      if (handle === 'term_coord') {
        return { handle, worktreeId: 'repo::wt', status: 'running' } as never
      }
      return { handle: 'term_worker', worktreeId: 'repo::wt', status: 'running' } as never
    })
    vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({
      id: 'repo::wt',
      repoId: 'repo'
    } as never)
    vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_worker',
      accepted: true,
      bytesWritten: 1
    })
  })

  afterEach(() => db.close())

  async function reserveWorkerReceipt(taskId: string): Promise<string> {
    const method = ORCHESTRATION_METHODS.find((c) => c.name === 'orchestration.dispatchReserve')!
    const params = method.params!.parse({ task: taskId, run: runId, from: 'term_coord' })
    const reserved = (await method.handler(params, { runtime })) as { receipt: unknown }
    return JSON.stringify(reserved.receipt)
  }

  async function startWorker(overrides: Record<string, unknown> = {}) {
    const task = db.createTask({ spec: 'role roster worker', runId })
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.workerStart'
    )
    if (!method) {
      throw new Error('workerStart method is not registered')
    }
    const params = method.params!.parse({
      task: task.id,
      from: 'term_coord',
      terminal: 'term_worker',
      receipt: await reserveWorkerReceipt(task.id),
      ...overrides
    })
    const result = (await method.handler(params, { runtime })) as { state: string }
    return { result, task }
  }

  it('registers the ready worker in the role roster keyed by pane and Run', async () => {
    const { result } = await startWorker({
      roleRoster: {
        role: 'worker',
        project: 'orca',
        board: 'roster',
        parentRole: 'supervisor',
        reportsTo: 'supervisor'
      }
    })
    expect(result.state).toBe('ready')
    const rows = db.listRoleRosters()
    expect(rows).toHaveLength(1)
    expect(rows[0].role).toBe('worker')
    expect(rows[0].kind).toBe('worker')
    expect(rows[0].pane).toBe(workerPaneKey)
    expect(rows[0].run_id).toBe(runId)
    expect(rows[0].parent_role).toBe('supervisor')
    expect(rows[0].reports_to).toBe('supervisor')
    expect(rows[0].last_seen_handle).toBe('term_worker')
    expect(rows[0].worktree).toBe('repo::wt')
  })

  it('leaves no roster record when role input is absent', async () => {
    const { result } = await startWorker()
    expect(result.state).toBe('ready')
    expect(db.listRoleRosters()).toHaveLength(0)
  })

  it('rejects an explicit roleRoster.runId that conflicts with the actual worker Run', async () => {
    await expect(
      startWorker({
        roleRoster: {
          role: 'worker',
          project: 'orca',
          board: 'roster',
          runId: 'run_not_the_worker_run'
        }
      })
    ).rejects.toThrowError(/conflicts/)
    expect(db.listRoleRosters()).toHaveLength(0)
  })
})
