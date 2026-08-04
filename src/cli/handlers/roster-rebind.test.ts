import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../format', () => ({ printResult: vi.fn() }))

import { printResult } from '../format'
import { ROSTER_HANDLERS } from './roster'

// Why: `roster rebind` must forward the full identity plus old and new panes
// to the RPC, and the human output must distinguish success from blockers.
describe('roster rebind CLI handler', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.mocked(printResult).mockReset()
  })

  function invoke(flags: Map<string, string | boolean>) {
    return ROSTER_HANDLERS['roster rebind']({
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
      ['role', 'worker'],
      ['from-pane', 'tab_1:leaf_1'],
      ['to-pane', 'tab_2:leaf_2'],
      ['run', 'run_1']
    ])

  it('maps every identity flag onto the RPC contract', async () => {
    callMock.mockResolvedValue({ result: { rebound: true, checklist: [], blockers: [] } })
    await invoke(fullFlags())
    expect(callMock).toHaveBeenCalledWith('orchestration.rosterRebind', {
      project: 'proj',
      board: 'board_a',
      role: 'worker',
      fromPane: 'tab_1:leaf_1',
      toPane: 'tab_2:leaf_2',
      run: 'run_1',
      terminalId: undefined,
      lastSeenHandle: undefined
    })
  })

  it('forwards optional terminal-id and last-seen-handle when provided', async () => {
    callMock.mockResolvedValue({ result: { rebound: true, checklist: [], blockers: [] } })
    const flags = fullFlags()
    flags.set('terminal-id', 'term_new')
    flags.set('last-seen-handle', 'term_new_live')
    await invoke(flags)
    expect(callMock.mock.calls[0][1]).toMatchObject({
      terminalId: 'term_new',
      lastSeenHandle: 'term_new_live'
    })
  })

  it.each(['from-pane', 'to-pane', 'run'])('requires --%s instead of guessing it', async (flag) => {
    const flags = fullFlags()
    flags.delete(flag)
    await expect(invoke(flags)).rejects.toThrow()
    expect(callMock).not.toHaveBeenCalled()
  })

  it('renders the blocking checklist step and says nothing changed', async () => {
    callMock.mockResolvedValue({
      rebound: false,
      member: null,
      checklist: [
        { code: 'single_active_candidate', passed: true, message: 'one candidate', detail: null },
        {
          code: 'old_pane_confirmed',
          passed: false,
          message: 'stale old pane',
          detail: 'given=tab_9 actual=tab_1'
        }
      ],
      blockers: [
        {
          code: 'old_pane_confirmed',
          passed: false,
          message: 'stale old pane',
          detail: 'given=tab_9 actual=tab_1'
        }
      ],
      warnings: ['stale old pane']
    })
    await invoke(fullFlags())
    const render = vi.mocked(printResult).mock.calls[0][2] as (value: unknown) => string
    const text = render(vi.mocked(printResult).mock.calls[0][0])
    expect(text).toContain('Not rebound')
    expect(text).toContain('stop old_pane_confirmed')
    expect(text).toContain('left untouched')
  })

  it('renders the new pane on a successful rebind', async () => {
    callMock.mockResolvedValue({
      rebound: true,
      member: {
        id: 'roster_1',
        pane: 'tab_2:leaf_2',
        run_id: 'run_1',
        terminal_id: 'term_new',
        last_seen_handle: 'term_new_live',
        status: 'active'
      },
      checklist: [
        { code: 'old_pane_confirmed', passed: true, message: 'matched', detail: 'tab_1:leaf_1' }
      ],
      blockers: [],
      warnings: []
    })
    await invoke(fullFlags())
    const render = vi.mocked(printResult).mock.calls[0][2] as (value: unknown) => string
    const text = render(vi.mocked(printResult).mock.calls[0][0])
    expect(text).toContain('Rebound roster_1')
    expect(text).toContain('pane=tab_2:leaf_2')
    expect(text).toContain('status=active')
  })
})
