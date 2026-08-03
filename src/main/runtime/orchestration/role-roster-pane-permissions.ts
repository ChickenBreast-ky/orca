import type { OrchestrationDb } from './db'
import type { RoleRosterRow } from './types'

// Why: the handle resolver is injected by the Orca runtime (which owns
// resolveTerminalPane) so this module stays free of a runtime dependency and
// is unit-testable with a stub. Implementations MUST match by stable pane
// leaf so a post-break-out pane key still resolves, and MAY throw for an
// unknown pane (the runtime resolver throws instead of returning null). A
// null return or a throw both mean "no live runtime terminal right now" —
// we leave last_seen_handle untouched.
export type RoleRosterPaneHandleResolver = (paneKey: string) => string | null

export type RoleRosterPanePermissions = {
  canDispatch: boolean
  canCommit: boolean
  canMessageSuper: boolean
}

export type RoleRosterPaneLookup = {
  roster: RoleRosterRow
  permissions: RoleRosterPanePermissions
  // Why: true only when last_seen_handle was stale and got rewritten to the
  // current runtime handle during this lookup.
  handleRefreshed: boolean
}

function toPermissionBit(value: number): boolean {
  return value !== 0
}

// Why: stable-pane identity (project+board+role+pane+run_id) survives Orca
// restarts and handle remints; this resolver reads the permissions straight
// off the roster row and reconciles a stale last_seen_handle against the
// actual live terminal. Only the Orca runtime calls this — companion/CLI must
// never refresh handles.
export function lookupRoleRosterPanePermissions(params: {
  db: OrchestrationDb
  rosterId: string
  resolveCurrentPaneHandle: RoleRosterPaneHandleResolver
}): RoleRosterPaneLookup | undefined {
  const { db, rosterId, resolveCurrentPaneHandle } = params
  const roster = db.getRoleRoster(rosterId)
  if (!roster) {
    return undefined
  }

  let handleRefreshed = false
  let currentHandle: string | null
  try {
    currentHandle = resolveCurrentPaneHandle(roster.pane)
  } catch {
    currentHandle = null
  }
  if (currentHandle && currentHandle !== roster.last_seen_handle) {
    const refreshed = db.refreshRoleRosterHandle(rosterId, currentHandle)
    if (refreshed) {
      handleRefreshed = true
      return {
        roster: refreshed,
        permissions: {
          canDispatch: toPermissionBit(refreshed.can_dispatch),
          canCommit: toPermissionBit(refreshed.can_commit),
          canMessageSuper: toPermissionBit(refreshed.can_message_super)
        },
        handleRefreshed
      }
    }
  }

  return {
    roster,
    permissions: {
      canDispatch: toPermissionBit(roster.can_dispatch),
      canCommit: toPermissionBit(roster.can_commit),
      canMessageSuper: toPermissionBit(roster.can_message_super)
    },
    handleRefreshed
  }
}
