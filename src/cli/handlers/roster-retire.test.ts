import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../format', () => ({ printResult: vi.fn() }))

import { printResult } from '../format'
import { ROSTER_HANDLERS } from './roster'

// Why: card 8 — `roster retire` must forward the full identity plus the card it
// closes, and the human output has to show which checklist step stopped it.
describe('roster retire CLI handler', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.mocked(printResult).mockReset()
  })

  function invoke(flags: Map<string, string | boolean>) {
    return ROSTER_HANDLERS['roster retire']({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)
  }

  const fullFlags = () =>
    new Map<string, string | boolean>([
      ['project', 'proj'],
      ['board', 'board_a'],
      ['role', 'card8-worker'],
      ['pane', 'tab_1:leaf_1'],
      ['run', 'run_1'],
      ['task', 'task_1'],
      ['dirty-changes-moved', true],
      ['dirty-changes-evidence', '/tmp/orca-evidence/card8/notes.md']
    ])

  it('maps every identity and checklist flag onto the RPC contract', async () => {
    callMock.mockResolvedValue({
      result: { retired: true, checklist: [], blockers: [] }
    })
    await invoke(fullFlags())
    expect(callMock).toHaveBeenCalledWith('orchestration.rosterRetire', {
      project: 'proj',
      board: 'board_a',
      role: 'card8-worker',
      pane: 'tab_1:leaf_1',
      run: 'run_1',
      task: 'task_1',
      dirtyChangesMoved: true,
      dirtyChangesEvidence: '/tmp/orca-evidence/card8/notes.md'
    })
  })

  it('sends no dirty-change confirmation when the flag is absent', async () => {
    callMock.mockResolvedValue({
      result: { retired: false, checklist: [], blockers: [] }
    })
    const flags = fullFlags()
    flags.delete('dirty-changes-moved')
    flags.delete('dirty-changes-evidence')
    await invoke(flags)
    expect(callMock.mock.calls[0][1]).toMatchObject({
      dirtyChangesMoved: undefined,
      dirtyChangesEvidence: undefined
    })
  })

  it.each(['pane', 'run', 'task'])('requires --%s instead of guessing it', async (flag) => {
    const flags = fullFlags()
    flags.delete(flag)
    await expect(invoke(flags)).rejects.toThrow()
    expect(callMock).not.toHaveBeenCalled()
  })

  it('renders the blocking checklist step and says nothing changed', async () => {
    callMock.mockResolvedValue({
      retired: false,
      member: null,
      checklist: [
        {
          code: 'single_active_candidate',
          passed: true,
          message: 'one candidate',
          detail: null
        },
        {
          code: 'task_completed',
          passed: false,
          message: 'still running',
          detail: 'dispatched'
        }
      ],
      blockers: [
        {
          code: 'task_completed',
          passed: false,
          message: 'still running',
          detail: 'dispatched'
        }
      ],
      warnings: ['still running']
    })
    await invoke(fullFlags())
    const render = vi.mocked(printResult).mock.calls[0][2] as (value: unknown) => string
    const text = render(vi.mocked(printResult).mock.calls[0][0])
    expect(text).toContain('Not retired')
    expect(text).toContain('stop task_completed')
    expect(text).toContain('left untouched')
    expect(text).toContain('no terminal was stopped')
  })

  it('renders the kept history on a successful retire', async () => {
    callMock.mockResolvedValue({
      retired: true,
      member: {
        id: 'roster_1',
        pane: 'tab_1:leaf_1',
        run_id: 'run_1',
        last_seen_handle: 'term_worker_old'
      },
      checklist: [
        {
          code: 'worker_done_recorded',
          passed: true,
          message: 'recorded',
          detail: 'msg_1'
        }
      ],
      blockers: [],
      warnings: []
    })
    await invoke(fullFlags())
    const render = vi.mocked(printResult).mock.calls[0][2] as (value: unknown) => string
    const text = render(vi.mocked(printResult).mock.calls[0][0])
    expect(text).toContain('Retired roster_1')
    expect(text).toContain('cachedHandle=term_worker_old')
    expect(text).toContain('excluded from active resolve')
  })
})
