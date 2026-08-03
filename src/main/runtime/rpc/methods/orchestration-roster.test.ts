import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import type { RpcMethod } from '../core'
import { ALL_RPC_METHODS } from './index'

// Why: card 3 — the roster RPC surface wires the query module to live runtime
// pane resolution: handles come from resolveTerminalPane, model/state from the
// agent-status summary, and ambiguity/not-found are explicit errors.
describe('orchestration roster RPC methods', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'resolveTerminalPane').mockImplementation((paneKey: string) => {
      if (paneKey === 'tab_1:leaf_dead') {
        throw new Error('terminal_not_found')
      }
      return { handle: `term_live_for_${paneKey}` } as never
    })
    vi.spyOn(runtime, 'getAgentStatusSummaryForPaneKey').mockImplementation((paneKey: string) =>
      paneKey === 'tab_1:leaf_model'
        ? { state: 'working', model: 'runtime-model' }
        : { state: null, model: null }
    )
    vi.spyOn(runtime, 'showManagedWorktree').mockImplementation(async (selector: string) => {
      if (selector === 'wt-selector') {
        return { id: 'repo::wt', repoId: 'repo' } as never
      }
      throw new Error('worktree_not_found')
    })
  })

  afterEach(() => db.close())

  function findMethod(name: string): RpcMethod {
    const method = ALL_RPC_METHODS.find((candidate) => candidate.name === name)
    if (!method) {
      throw new Error(`${name} is not registered`)
    }
    return method as RpcMethod
  }

  function seedMember(overrides?: Partial<Parameters<OrchestrationDb['createRoleRoster']>[0]>) {
    return db.createRoleRoster({
      pane: 'tab_1:leaf_1',
      project: 'proj',
      board: 'board_a',
      role: 'worker',
      runId: 'run_1',
      ...overrides
    })
  }

  it('registers all four roster methods', () => {
    for (const name of [
      'orchestration.rosterList',
      'orchestration.rosterShow',
      'orchestration.rosterResolve',
      'orchestration.rosterSummary'
    ]) {
      expect(findMethod(name).name).toBe(name)
    }
  })

  it('lists members with runtime-resolved handles and facts', async () => {
    seedMember({ pane: 'tab_1:leaf_model', lastSeenHandle: 'term_old' })
    seedMember({ pane: 'tab_1:leaf_dead', role: 'reviewer' })
    const method = findMethod('orchestration.rosterList')
    const result = (await method.handler(method.params!.parse({}), { runtime })) as {
      members: {
        pane: string
        currentHandle: string | null
        lifecycle: string
        model: string | null
      }[]
    }
    expect(result.members).toHaveLength(2)
    const live = result.members.find((member) => member.pane === 'tab_1:leaf_model')
    expect(live?.currentHandle).toBe('term_live_for_tab_1:leaf_model')
    expect(live?.model).toBe('runtime-model')
    const dead = result.members.find((member) => member.pane === 'tab_1:leaf_dead')
    expect(dead?.currentHandle).toBeNull()
    expect(dead?.lifecycle).toBe('stale')
  })

  it('filters list by the resolved worktree id of a selector', async () => {
    seedMember({ worktree: 'repo::wt' })
    seedMember({ pane: 'tab_2:leaf_2', worktree: 'repo::other' })
    const method = findMethod('orchestration.rosterList')
    const result = (await method.handler(method.params!.parse({ worktree: 'wt-selector' }), {
      runtime
    })) as { members: { worktree: string | null }[] }
    expect(result.members).toHaveLength(1)
    expect(result.members[0].worktree).toBe('repo::wt')
  })

  it('show refreshes a stale handle cache through the pane boundary', async () => {
    const row = seedMember({ lastSeenHandle: 'term_A' })
    const method = findMethod('orchestration.rosterShow')
    const result = (await method.handler(
      method.params!.parse({ project: 'proj', board: 'board_a', role: 'worker' }),
      { runtime }
    )) as { member: { currentHandle: string | null; handleRefreshed: boolean } }
    expect(result.member.currentHandle).toBe('term_live_for_tab_1:leaf_1')
    expect(result.member.handleRefreshed).toBe(true)
    expect(db.getRoleRoster(row.id)?.last_seen_handle).toBe('term_live_for_tab_1:leaf_1')
  })

  it('show fails explicitly on zero and ambiguous candidates', async () => {
    const method = findMethod('orchestration.rosterShow')
    await expect(
      method.handler(method.params!.parse({ project: 'proj', board: 'board_a', role: 'ghost' }), {
        runtime
      })
    ).rejects.toMatchObject({ code: 'role_roster_not_found' })
    seedMember({ pane: 'tab_1:leaf_1' })
    seedMember({ pane: 'tab_2:leaf_2' })
    await expect(
      method.handler(method.params!.parse({ project: 'proj', board: 'board_a', role: 'worker' }), {
        runtime
      })
    ).rejects.toMatchObject({ code: 'role_roster_ambiguous' })
  })

  it('resolve returns a null handle without guessing when the pane is dead', async () => {
    seedMember({ pane: 'tab_1:leaf_dead', lastSeenHandle: 'term_cached' })
    const method = findMethod('orchestration.rosterResolve')
    const result = (await method.handler(
      method.params!.parse({ project: 'proj', board: 'board_a', role: 'worker' }),
      { runtime }
    )) as { currentHandle: string | null; live: boolean; member: { lastSeenHandle: string | null } }
    expect(result.currentHandle).toBeNull()
    expect(result.live).toBe(false)
    expect(result.member.lastSeenHandle).toBe('term_cached')
  })

  it('summary requires --all or a scope and separates cleanup candidates', async () => {
    const method = findMethod('orchestration.rosterSummary')
    await expect(method.handler(method.params!.parse({}), { runtime })).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    seedMember({ pane: 'tab_1:leaf_sup', role: 'supervisor', kind: 'supervisor' })
    const settled = seedMember({ pane: 'tab_2:leaf_done', role: 'worker' })
    seedMember({ pane: 'tab_1:leaf_dead', role: 'worker' })
    db.deactivateRoleRoster(settled.id)
    const result = (await method.handler(method.params!.parse({ all: true }), { runtime })) as {
      summary: {
        activeSupervisors: { count: number; roles: string[] }
        workers: { live: number; stale: number; inactive: number; retired: number }
        cleanupCandidates: { lifecycle: string }[]
      }
    }
    expect(result.summary.activeSupervisors).toEqual({ count: 1, roles: ['supervisor'] })
    expect(result.summary.workers).toEqual({ live: 0, stale: 1, inactive: 1, retired: 0 })
    expect(result.summary.cleanupCandidates).toHaveLength(2)
  })

  it('rejects invalid status filters at the schema boundary', () => {
    const method = findMethod('orchestration.rosterList')
    expect(() => method.params!.parse({ status: 'settled' })).toThrow()
  })
})
