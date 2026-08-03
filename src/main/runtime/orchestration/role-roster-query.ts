import type { OrchestrationDb } from './db'
import { OrchestrationError } from './orchestration-error'
import {
  lookupRoleRosterPanePermissions,
  type RoleRosterPaneHandleResolver
} from './role-roster-pane-permissions'
import type { RoleRosterRow, RoleRosterStatus } from './types'

// Why: card 3 — read-only roster queries. Identity stays
// project+board+role+pane+run_id; the handle is resolved live from the stable
// pane and last_seen_handle is reported as a cache, never as truth. Title and
// stored handle are never selection inputs and never fill unknown values.
export type RoleRosterPaneFacts = {
  state: string | null
  model: string | null
}

export type RoleRosterQueryRuntime = {
  resolveCurrentPaneHandle: RoleRosterPaneHandleResolver
  getPaneFacts?: (paneKey: string) => RoleRosterPaneFacts | null
}

// Why: the stored status only knows active/inactive; lifecycle adds the
// runtime-observed stale state (active record, dead pane) so supervisors can
// tell settled workers from cleanup candidates.
// Why: card 8 — retired is its own lifecycle, not another inactive. It means
// the card-close checklist already ran, so the row is settled history rather
// than a pane still waiting to be cleaned up.
export type RoleRosterLifecycle = 'active' | 'stale' | 'inactive' | 'retired'

export type RoleRosterMember = {
  id: string
  pane: string
  worktree: string | null
  project: string
  board: string
  role: string
  runId: string
  parentRole: string | null
  reportsTo: string | null
  kind: RoleRosterRow['kind']
  status: RoleRosterStatus
  lifecycle: RoleRosterLifecycle
  live: boolean
  cleanupCandidate: boolean
  currentHandle: string | null
  lastSeenHandle: string | null
  model: string | null
  agentState: string | null
  title: string | null
  canDispatch: boolean
  canCommit: boolean
  canMessageSuper: boolean
  createdAt: string
  updatedAt: string
}

export type RoleRosterIdentityFilter = {
  project: string
  board: string
  role: string
  runId?: string
}

function resolveLiveHandle(runtime: RoleRosterQueryRuntime, paneKey: string): string | null {
  try {
    return runtime.resolveCurrentPaneHandle(paneKey)
  } catch {
    return null
  }
}

function toMember(
  row: RoleRosterRow,
  runtime: RoleRosterQueryRuntime,
  currentHandle: string | null
): RoleRosterMember {
  const facts = runtime.getPaneFacts?.(row.pane) ?? null
  const live = row.status === 'active' && currentHandle !== null
  const lifecycle: RoleRosterLifecycle =
    row.status === 'retired'
      ? 'retired'
      : row.status !== 'active'
        ? 'inactive'
        : live
          ? 'active'
          : 'stale'
  return {
    id: row.id,
    pane: row.pane,
    worktree: row.worktree,
    project: row.project,
    board: row.board,
    role: row.role,
    runId: row.run_id,
    parentRole: row.parent_role,
    reportsTo: row.reports_to,
    kind: row.kind,
    status: row.status,
    lifecycle,
    live,
    cleanupCandidate: lifecycle !== 'active' && lifecycle !== 'retired',
    currentHandle,
    lastSeenHandle: row.last_seen_handle,
    model: facts?.model ?? row.model,
    agentState: facts?.state ?? null,
    title: row.title,
    canDispatch: row.can_dispatch !== 0,
    canCommit: row.can_commit !== 0,
    canMessageSuper: row.can_message_super !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function listRoleRosterMembers(params: {
  db: OrchestrationDb
  runtime: RoleRosterQueryRuntime
  filter?: {
    status?: RoleRosterStatus
    runId?: string
    project?: string
    board?: string
    role?: string
    worktree?: string
    worktreeId?: string
  }
}): RoleRosterMember[] {
  const rows = params.db.listRoleRosters({
    status: params.filter?.status,
    runId: params.filter?.runId,
    project: params.filter?.project,
    board: params.filter?.board,
    role: params.filter?.role
  })
  const worktree = params.filter?.worktree
  const worktreeId = params.filter?.worktreeId
  const matched =
    worktree || worktreeId
      ? rows.filter((row) => row.worktree === worktree || row.worktree === worktreeId)
      : rows
  // Why: list is read-only — handles are resolved live for display but the
  // last_seen_handle cache is only refreshed on a single-candidate show/resolve.
  return matched.map((row) =>
    toMember(row, params.runtime, resolveLiveHandle(params.runtime, row.pane))
  )
}

// Why: card 4 send-by-role reuses this exact zero/ambiguous/single verdict so
// targeting can never silently widen beyond the card 3 query contract.
export function findSingleActiveRoleRosterCandidate(
  db: OrchestrationDb,
  identity: RoleRosterIdentityFilter
): RoleRosterRow {
  const candidates = db.listRoleRosters({
    project: identity.project,
    board: identity.board,
    role: identity.role,
    runId: identity.runId,
    status: 'active'
  })
  if (candidates.length === 0) {
    throw new OrchestrationError(
      'role_roster_not_found',
      `No active role roster record matches ${identity.project}/${identity.board}/${identity.role}${identity.runId ? `/${identity.runId}` : ''}.`
    )
  }
  if (candidates.length > 1) {
    throw new OrchestrationError(
      'role_roster_ambiguous',
      `Multiple active role roster records match ${identity.project}/${identity.board}/${identity.role}${identity.runId ? `/${identity.runId}` : ''}; refusing to auto-select.`,
      { candidates: candidates.map((row) => ({ id: row.id, pane: row.pane, runId: row.run_id })) }
    )
  }
  return candidates[0]
}

export function showRoleRosterMember(params: {
  db: OrchestrationDb
  runtime: RoleRosterQueryRuntime
  identity: RoleRosterIdentityFilter
}): RoleRosterMember & { handleRefreshed: boolean } {
  const candidate = findSingleActiveRoleRosterCandidate(params.db, params.identity)
  // Why: exactly one candidate — the runtime boundary may refresh a stale
  // last_seen_handle against the live pane; zero/ambiguous candidates never
  // reach this point.
  const lookup = lookupRoleRosterPanePermissions({
    db: params.db,
    rosterId: candidate.id,
    resolveCurrentPaneHandle: params.runtime.resolveCurrentPaneHandle
  })
  const roster = lookup?.roster ?? candidate
  const currentHandle = resolveLiveHandle(params.runtime, roster.pane)
  return {
    ...toMember(roster, params.runtime, currentHandle),
    handleRefreshed: lookup?.handleRefreshed ?? false
  }
}

export function resolveRoleRosterMember(params: {
  db: OrchestrationDb
  runtime: RoleRosterQueryRuntime
  identity: RoleRosterIdentityFilter
}): { member: RoleRosterMember; handleRefreshed: boolean } {
  const member = showRoleRosterMember(params)
  return { member, handleRefreshed: member.handleRefreshed }
}

export type RoleRosterSummary = {
  scope: { project: string | null; board: string | null }
  totals: { active: number; stale: number; inactive: number; retired: number }
  activeSupervisors: { count: number; roles: string[] }
  activeCoordinators: { count: number; roles: string[] }
  workers: { live: number; stale: number; inactive: number; retired: number }
  cleanupCandidates: {
    id: string
    project: string
    board: string
    role: string
    runId: string
    lifecycle: RoleRosterLifecycle
  }[]
}

export function summarizeRoleRoster(params: {
  db: OrchestrationDb
  runtime: RoleRosterQueryRuntime
  filter?: { project?: string; board?: string }
}): RoleRosterSummary {
  const members = listRoleRosterMembers({
    db: params.db,
    runtime: params.runtime,
    filter: { project: params.filter?.project, board: params.filter?.board }
  })
  const live = members.filter((member) => member.lifecycle === 'active')
  const stale = members.filter((member) => member.lifecycle === 'stale')
  const inactive = members.filter((member) => member.lifecycle === 'inactive')
  const retired = members.filter((member) => member.lifecycle === 'retired')
  const liveOfKind = (kind: RoleRosterRow['kind']) => live.filter((member) => member.kind === kind)
  const workersOf = (bucket: RoleRosterMember[]) =>
    bucket.filter((member) => member.kind === 'worker').length
  return {
    scope: { project: params.filter?.project ?? null, board: params.filter?.board ?? null },
    totals: {
      active: live.length,
      stale: stale.length,
      inactive: inactive.length,
      retired: retired.length
    },
    activeSupervisors: {
      count: liveOfKind('supervisor').length,
      roles: liveOfKind('supervisor').map((member) => member.role)
    },
    activeCoordinators: {
      count: liveOfKind('coordinator').length,
      roles: liveOfKind('coordinator').map((member) => member.role)
    },
    workers: {
      live: workersOf(live),
      stale: workersOf(stale),
      inactive: workersOf(inactive),
      retired: workersOf(retired)
    },
    cleanupCandidates: members
      .filter((member) => member.cleanupCandidate)
      .map((member) => ({
        id: member.id,
        project: member.project,
        board: member.board,
        role: member.role,
        runId: member.runId,
        lifecycle: member.lifecycle
      }))
  }
}
