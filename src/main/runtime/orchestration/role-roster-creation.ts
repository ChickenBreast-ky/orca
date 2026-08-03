import { z } from 'zod'
import type { OrchestrationDb } from './db'
import { OrchestrationError } from './orchestration-error'
import type { RoleRosterKind, RoleRosterRow } from './types'

// Why: card 2 wires role input into the terminal/worker creation paths so a
// new supervisor, relay, or worker leaves an official role_roster record at
// birth. Identity is project+board+role+pane+run_id; the handle is stored
// only as the last_seen_handle cache.
export const RoleRosterCreateParamsSchema = z.object({
  role: z.string().min(1).max(128),
  project: z.string().min(1).max(256),
  board: z.string().min(1).max(256),
  runId: z.string().min(1).max(128).optional(),
  parentRole: z.string().min(1).max(128).optional(),
  reportsTo: z.string().min(1).max(128).optional()
})

export type RoleRosterCreateParams = z.infer<typeof RoleRosterCreateParamsSchema>

// Why: kind is a coarse bucket (coordinator/supervisor/worker); fine-grained
// roles like relay or reviewer stay workers at the kind level and are
// distinguished by the role string itself.
export function deriveRoleRosterKind(role: string): RoleRosterKind {
  if (role === 'coordinator') {
    return 'coordinator'
  }
  if (role.includes('supervisor')) {
    return 'supervisor'
  }
  return 'worker'
}

export function recordCreatedRoleRoster(params: {
  db: OrchestrationDb
  input: RoleRosterCreateParams
  pane: string
  terminalHandle: string
  defaultRunId?: string
  worktree?: string
  title?: string
}): RoleRosterRow {
  if (params.input.runId && params.defaultRunId && params.input.runId !== params.defaultRunId) {
    throw new OrchestrationError(
      'invalid_argument',
      `role roster runId ${params.input.runId} conflicts with the actual Run ${params.defaultRunId}.`
    )
  }
  const runId = params.input.runId ?? params.defaultRunId
  if (!runId) {
    throw new OrchestrationError(
      'invalid_argument',
      'role roster creation requires a Run id (--run) when no current Run supplies one.'
    )
  }
  return params.db.ensureActiveRoleRoster({
    pane: params.pane,
    project: params.input.project,
    board: params.input.board,
    role: params.input.role,
    runId,
    terminalId: params.terminalHandle,
    worktree: params.worktree,
    parentRole: params.input.parentRole,
    reportsTo: params.input.reportsTo,
    kind: deriveRoleRosterKind(params.input.role),
    title: params.title,
    lastSeenHandle: params.terminalHandle
  })
}

// Why: keeps the worker-start call site inside the max-lines budget while the
// no-role case stays a no-op; typed structurally so this module does not
// depend on the RPC schema module.
export function recordWorkerRoster(
  db: OrchestrationDb,
  params: { roleRoster?: RoleRosterCreateParams; displayName?: string },
  pane: string,
  terminalHandle: string,
  runId: string,
  worktree: string
): RoleRosterRow | undefined {
  if (!params.roleRoster) {
    return undefined
  }
  return recordCreatedRoleRoster({
    db,
    input: params.roleRoster,
    pane,
    terminalHandle,
    defaultRunId: runId,
    worktree,
    title: params.displayName
  })
}

// Why: card 2 — validate roster identity before any side effect, then hand
// back the post-ready recorder. A rejection after dispatch-ready would
// strand a live worker the receipt machine can no longer fail, so late
// failures degrade to a warning log instead.
export function prepareWorkerRoster(
  db: OrchestrationDb,
  params: { roleRoster?: RoleRosterCreateParams; displayName?: string; terminal?: string },
  runId: string,
  runtime: { getTerminalPaneKey(handle: string): string | null }
): ((pane: string, terminalHandle: string, worktree: string) => void) | undefined {
  const roleRoster = params.roleRoster
  if (!roleRoster) {
    return undefined
  }
  if (roleRoster.runId && roleRoster.runId !== runId) {
    throw new OrchestrationError(
      'invalid_argument',
      `role roster runId ${roleRoster.runId} conflicts with the actual Run ${runId}.`
    )
  }
  const pane = params.terminal ? runtime.getTerminalPaneKey(params.terminal) : null
  if (pane) {
    db.assertRoleRosterIdentityAvailable({
      project: roleRoster.project,
      board: roleRoster.board,
      role: roleRoster.role,
      runId,
      pane
    })
  }
  return (workerPane, terminalHandle, worktree) => {
    try {
      recordWorkerRoster(db, params, workerPane, terminalHandle, runId, worktree)
    } catch (error) {
      console.warn('[role-roster] Failed to record roster for started worker', {
        terminalHandle,
        pane: workerPane,
        runId,
        error
      })
    }
  }
}
