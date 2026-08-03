import type { OrchestrationDb } from './db'
import { OrchestrationError } from './orchestration-error'
import {
  findSingleActiveRoleRosterCandidate,
  type RoleRosterIdentityFilter
} from './role-roster-query'
import type { RoleRosterRow } from './types'

// Why: card 4 — role-based send targeting. The roster identity
// (project+board+role+run) picks exactly one active record; the stable pane
// then resolves the current runtime handle. last_seen_handle is a cache that
// is never tried first and never retried after a failure; title is never a
// selection input.
export type RoleRosterSendTarget = {
  roster: RoleRosterRow
  handle: string
  handleRefreshed: boolean
}

// Why: the resolver is injected by the Orca runtime (owner of
// resolveTerminalPane) so this module stays runtime-free and unit-testable.
// It MUST resolve by stable pane and MUST throw Error('terminal_not_found')
// when the pane has no live terminal; any other throw means the runtime
// boundary itself failed.
export type RoleRosterSendTargetResolver = (paneKey: string) => string

function classifyResolveFailure(error: unknown, roster: RoleRosterRow): OrchestrationError {
  const identity = `${roster.project}/${roster.board}/${roster.role}/${roster.run_id}`
  if (error instanceof Error && error.message === 'terminal_not_found') {
    return new OrchestrationError(
      'role_roster_pane_unresolved',
      `Role ${identity} has no live terminal for pane ${roster.pane}; nothing was sent and no cached handle was tried.`,
      { rosterId: roster.id, pane: roster.pane }
    )
  }
  return new OrchestrationError(
    'role_roster_runtime_disconnected',
    `Role ${identity} could not resolve pane ${roster.pane} against the runtime; nothing was sent and no cached handle was tried.`,
    { rosterId: roster.id, pane: roster.pane }
  )
}

export function resolveRoleRosterSendTarget(params: {
  db: OrchestrationDb
  identity: Required<RoleRosterIdentityFilter>
  resolveCurrentPaneHandle: RoleRosterSendTargetResolver
}): RoleRosterSendTarget {
  const roster = findSingleActiveRoleRosterCandidate(params.db, params.identity)
  const resolve = () => {
    try {
      return params.resolveCurrentPaneHandle(roster.pane)
    } catch (error) {
      throw classifyResolveFailure(error, roster)
    }
  }
  const handle = resolve()
  // Why: a remint between resolve and insert would misdeliver to the old
  // handle; the narrowest Orca-internal boundary is a same-turn re-resolve —
  // a changed verdict fails closed instead of sending to a stale target.
  const verified = resolve()
  if (verified !== handle) {
    throw new OrchestrationError(
      'role_roster_handle_changed',
      `Role ${roster.project}/${roster.board}/${roster.role}/${roster.run_id} changed runtime handle during targeting; nothing was sent. Retry to re-resolve the current handle.`,
      { rosterId: roster.id, pane: roster.pane }
    )
  }
  if (handle !== roster.last_seen_handle) {
    const refreshed = params.db.refreshRoleRosterHandle(roster.id, handle)
    if (refreshed) {
      return { roster: refreshed, handle, handleRefreshed: true }
    }
  }
  return { roster, handle, handleRefreshed: false }
}
