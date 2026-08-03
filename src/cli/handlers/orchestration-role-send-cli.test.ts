import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const getTerminalHandleMock = vi.hoisted(() => vi.fn())

// Why: isolate the handler's flag-to-param mapping; printResult only writes output.
vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { printResult } from '../format'

// Why: card 4 — the CLI exposes explicit role targeting on send and refuses
// ambiguous input before any RPC: a raw handle plus a role target, or a role
// target missing part of its official identity, never leaves the client.
describe('orchestration send role targeting flags', () => {
  beforeEach(() => {
    callMock.mockReset().mockResolvedValue({ result: { message: { id: 'msg_1' } } })
    getTerminalHandleMock.mockReset()
    vi.mocked(printResult).mockReset()
    delete process.env.ORCA_TERMINAL_HANDLE
    delete process.env.ORCA_PANE_KEY
  })

  const invokeSend = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration send']({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

  it('maps --to-role with its full identity onto the RPC contract', async () => {
    await invokeSend(
      new Map<string, string | boolean>([
        ['from', 'term_worker'],
        ['to-role', 'supervisor'],
        ['project', 'proj'],
        ['board', 'board_a'],
        ['run', 'run_1'],
        ['subject', 'status']
      ])
    )
    expect(callMock).toHaveBeenCalledWith(
      'orchestration.send',
      expect.objectContaining({
        from: 'term_worker',
        to: undefined,
        role: 'supervisor',
        project: 'proj',
        board: 'board_a',
        run: 'run_1',
        subject: 'status'
      })
    )
  })

  it('rejects a raw --to combined with --to-role before any RPC', async () => {
    await expect(
      invokeSend(
        new Map<string, string | boolean>([
          ['from', 'term_worker'],
          ['to', 'term_raw'],
          ['to-role', 'supervisor'],
          ['project', 'proj'],
          ['board', 'board_a'],
          ['run', 'run_1'],
          ['subject', 'conflict']
        ])
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(callMock).not.toHaveBeenCalled()
  })

  it('rejects a role target missing part of its identity', async () => {
    await expect(
      invokeSend(
        new Map<string, string | boolean>([
          ['from', 'term_worker'],
          ['to-role', 'supervisor'],
          ['project', 'proj'],
          ['subject', 'incomplete']
        ])
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(callMock).not.toHaveBeenCalled()
  })

  it('rejects --project/--board without --to-role', async () => {
    await expect(
      invokeSend(
        new Map<string, string | boolean>([
          ['from', 'term_worker'],
          ['to', 'term_coord'],
          ['project', 'proj'],
          ['subject', 'orphan flags']
        ])
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(callMock).not.toHaveBeenCalled()
  })

  it('prints the resolved role target in human output', async () => {
    callMock.mockResolvedValue({
      result: {
        message: { id: 'msg_9' },
        roleTarget: {
          project: 'proj',
          board: 'board_a',
          role: 'supervisor',
          runId: 'run_1',
          pane: 'tab_1:leaf_1',
          handle: 'term_B',
          handleRefreshed: true
        }
      }
    })
    await invokeSend(
      new Map<string, string | boolean>([
        ['from', 'term_worker'],
        ['to-role', 'supervisor'],
        ['project', 'proj'],
        ['board', 'board_a'],
        ['run', 'run_1'],
        ['subject', 'status']
      ])
    )
    const formatter = vi.mocked(printResult).mock.calls[0]?.[2] as (value: unknown) => string
    const text = formatter({
      message: { id: 'msg_9' },
      roleTarget: {
        project: 'proj',
        board: 'board_a',
        role: 'supervisor',
        runId: 'run_1',
        pane: 'tab_1:leaf_1',
        handle: 'term_B',
        handleRefreshed: true
      }
    })
    expect(text).toBe('Sent msg_9 to proj/board_a/supervisor -> term_B')
  })

  // Why: card 7 fix — the structured upper report envelope travels as a raw
  // --payload JSON string (companion contract); the CLI must hand it to the
  // RPC untouched on both the direct run: path and the --to-role path.
  it('passes a raw upper report payload through on the direct run path', async () => {
    const payload = JSON.stringify({
      taskId: 'task_1',
      dispatchId: 'ctx_1',
      upperReport: true,
      outcome: 'succeeded',
      nextAction: 'next card'
    })
    await invokeSend(
      new Map<string, string | boolean>([
        ['from', 'term_sup'],
        ['to', 'run:run_super'],
        ['type', 'status'],
        ['subject', 'card complete'],
        ['payload', payload]
      ])
    )
    expect(callMock).toHaveBeenCalledWith(
      'orchestration.send',
      expect.objectContaining({
        from: 'term_sup',
        to: 'run:run_super',
        type: 'status',
        payload
      })
    )
  })

  it('passes a raw upper report payload through on the role path', async () => {
    const payload = JSON.stringify({
      taskId: 'task_1',
      dispatchId: 'ctx_1',
      upperReport: true,
      outcome: 'succeeded',
      nextAction: 'next card'
    })
    await invokeSend(
      new Map<string, string | boolean>([
        ['from', 'term_sup'],
        ['to-role', 'super_supervisor'],
        ['project', 'proj'],
        ['board', 'board_a'],
        ['run', 'run_super'],
        ['type', 'status'],
        ['subject', 'card complete'],
        ['payload', payload]
      ])
    )
    expect(callMock).toHaveBeenCalledWith(
      'orchestration.send',
      expect.objectContaining({
        from: 'term_sup',
        role: 'super_supervisor',
        run: 'run_super',
        type: 'status',
        payload
      })
    )
  })
})
