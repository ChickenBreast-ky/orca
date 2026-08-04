import { describe, expect, it } from 'vitest'
import { formatTerminalCreate, formatTerminalFocus } from './terminal-format'

describe('formatTerminalCreate', () => {
  const baseTerminal = {
    handle: 'term_1',
    worktreeId: 'repo::wt',
    title: null
  }

  it('names the registered roster member on the receipt', () => {
    expect(
      formatTerminalCreate({
        terminal: {
          ...baseTerminal,
          roleRoster: {
            registered: true,
            member: {
              id: 'roster_1',
              pane: 'tab_1:leaf_1',
              project: 'orca',
              board: 'roster',
              role: 'relay',
              runId: 'run_1',
              kind: 'worker',
              status: 'active',
              parentRole: null,
              reportsTo: null,
              lastSeenHandle: 'term_1',
              createdAt: '2026-08-04 00:00:00',
              updatedAt: '2026-08-04 00:00:00'
            }
          }
        }
      })
    ).toBe('Created terminal term_1\nrole roster: registered relay [roster_1]')
  })

  it('shows the failure from the structured field when no warning was set', () => {
    expect(
      formatTerminalCreate({
        terminal: {
          ...baseTerminal,
          roleRoster: {
            registered: false,
            error: { code: 'role_roster_conflict', message: 'Role relay is already active.' }
          }
        }
      })
    ).toBe(
      'Created terminal term_1\nrole roster: registration failed (role_roster_conflict): Role relay is already active.'
    )
  })

  it('lets the warning carry the failure detail instead of printing it twice', () => {
    expect(
      formatTerminalCreate({
        terminal: {
          ...baseTerminal,
          warning:
            'Role roster registration failed (role_roster_conflict): Role relay is already active.',
          roleRoster: {
            registered: false,
            error: { code: 'role_roster_conflict', message: 'Role relay is already active.' }
          }
        }
      })
    ).toBe(
      'Created terminal term_1\nwarning: Role roster registration failed (role_roster_conflict): Role relay is already active.'
    )
  })

  it('stays unchanged when no roster input was given', () => {
    expect(formatTerminalCreate({ terminal: baseTerminal })).toBe('Created terminal term_1')
  })
})

describe('formatTerminalFocus', () => {
  it('distinguishes superseded navigation from a winning focus', () => {
    expect(
      formatTerminalFocus({
        focus: {
          handle: 'term_stale',
          tabId: 'tab-stale',
          worktreeId: 'worktree-1',
          navigated: false
        }
      })
    ).toBe(
      'Focus request for terminal term_stale was superseded or host navigation was skipped (tab tab-stale).'
    )
    expect(
      formatTerminalFocus({
        focus: { handle: 'term_winner', tabId: 'tab-winner', worktreeId: 'worktree-1' }
      })
    ).toBe('Focused terminal term_winner (tab tab-winner).')
  })
})
