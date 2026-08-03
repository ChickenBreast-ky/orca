import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../format', () => ({ printResult: vi.fn() }))

import { printResult } from '../format'
import { ROSTER_HANDLERS } from './roster'

// Why: card 3 — CLI handlers must map flags onto the roster RPC contract
// exactly; identity commands require project+board+role and never invent
// handle/title fallbacks.
describe('roster CLI handlers', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.mocked(printResult).mockReset()
  })

  function invoke(key: keyof typeof ROSTER_HANDLERS, flags: Map<string, string | boolean>) {
    return ROSTER_HANDLERS[key]({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)
  }

  it('lists with every filter mapped through', async () => {
    callMock.mockResolvedValue({ result: { members: [] } })
    await invoke(
      'roster list',
      new Map([
        ['worktree', 'wt-selector'],
        ['project', 'proj'],
        ['board', 'board_a'],
        ['role', 'worker'],
        ['run', 'run_1'],
        ['status', 'active']
      ])
    )
    expect(callMock).toHaveBeenCalledWith('orchestration.rosterList', {
      worktree: 'wt-selector',
      project: 'proj',
      board: 'board_a',
      role: 'worker',
      run: 'run_1',
      status: 'active'
    })
  })

  it('show and resolve require the role identity and pass an optional Run', async () => {
    callMock.mockResolvedValue({ result: { member: {} } })
    await invoke(
      'roster show',
      new Map([
        ['project', 'proj'],
        ['board', 'board_a'],
        ['role', 'supervisor']
      ])
    )
    expect(callMock).toHaveBeenCalledWith('orchestration.rosterShow', {
      project: 'proj',
      board: 'board_a',
      role: 'supervisor',
      run: undefined
    })
    await invoke(
      'roster resolve',
      new Map([
        ['project', 'proj'],
        ['board', 'board_a'],
        ['role', 'supervisor'],
        ['run', 'run_9']
      ])
    )
    expect(callMock).toHaveBeenCalledWith('orchestration.rosterResolve', {
      project: 'proj',
      board: 'board_a',
      role: 'supervisor',
      run: 'run_9'
    })
  })

  it('summary sends all only when the flag is present', async () => {
    callMock.mockResolvedValue({ result: { summary: {} } })
    await invoke('roster summary', new Map([['all', true]]))
    expect(callMock).toHaveBeenCalledWith('orchestration.rosterSummary', {
      all: true,
      project: undefined,
      board: undefined
    })
    await invoke('roster summary', new Map([['project', 'proj']]))
    expect(callMock).toHaveBeenLastCalledWith('orchestration.rosterSummary', {
      all: undefined,
      project: 'proj',
      board: undefined
    })
  })
})
