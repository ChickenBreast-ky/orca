import { isEquivalentPaneKey, type OrchestrationDb } from './db'
import type { RoleRosterRow } from './types'

// Why: a terminal replacement must not force a human to edit the DB by hand.
// Rebind moves an active role identity (project+board+role+run) from one stable
// pane to another through a fail-closed checklist, so the record stays active
// and resolvable while its location changes. Only the pane, terminal_id, and
// last_seen_handle mutate; the identity fields never do.
export type RoleRosterRebindStepCode =
  | 'single_active_candidate'
  | 'old_pane_confirmed'
  | 'new_pane_available'
  | 'record_still_active'

export type RoleRosterRebindStep = {
  code: RoleRosterRebindStepCode
  passed: boolean
  message: string
  detail: string | null
}

export type RoleRosterRebindIdentity = {
  project: string
  board: string
  role: string
  runId: string
  fromPane: string
  toPane: string
}

export type RoleRosterRebindResult = {
  rebound: boolean
  member: RoleRosterRow | null
  checklist: RoleRosterRebindStep[]
  blockers: RoleRosterRebindStep[]
  warnings: string[]
}

function step(
  code: RoleRosterRebindStepCode,
  passed: boolean,
  message: string,
  detail?: string | null
): RoleRosterRebindStep {
  return { code, passed, message, detail: detail ?? null }
}

// Why: identity is project+board+role+run_id. Zero active candidates means
// nothing to rebind; two or more is an explicit ambiguity that is never
// auto-resolved by picking the first, a title, or a cached handle.
function resolveRebindCandidate(
  db: OrchestrationDb,
  identity: RoleRosterRebindIdentity
): { candidate: RoleRosterRow | null; step: RoleRosterRebindStep } {
  const actives = db.listRoleRosters({
    project: identity.project,
    board: identity.board,
    role: identity.role,
    runId: identity.runId,
    status: 'active'
  })
  const label = `${identity.project}/${identity.board}/${identity.role} run=${identity.runId}`
  if (actives.length === 0) {
    return {
      candidate: null,
      step: step(
        'single_active_candidate',
        false,
        `No active roster record holds ${label}.`,
        'nothing to rebind'
      )
    }
  }
  if (actives.length > 1) {
    return {
      candidate: null,
      step: step(
        'single_active_candidate',
        false,
        `${actives.length} active roster records hold ${label}; refusing to rebind by guess.`,
        actives.map((row) => `${row.id}@${row.pane}`).join(', ')
      )
    }
  }
  return {
    candidate: actives[0],
    step: step(
      'single_active_candidate',
      true,
      `Exactly one active roster record holds ${label}.`,
      actives[0].id
    )
  }
}

export function rebindRoleRosterMember(params: {
  db: OrchestrationDb
  identity: RoleRosterRebindIdentity
  terminalId?: string
  lastSeenHandle?: string
}): RoleRosterRebindResult {
  const { db, identity } = params
  const resolved = resolveRebindCandidate(db, identity)
  const checklist: RoleRosterRebindStep[] = [resolved.step]

  // Why: without a resolved candidate the remaining steps are meaningless.
  if (!resolved.candidate) {
    return {
      rebound: false,
      member: null,
      checklist,
      blockers: [resolved.step],
      warnings: [resolved.step.message]
    }
  }
  const candidate = resolved.candidate

  // Why: the caller must prove they know the current pane before moving it.
  // A wrong old-pane is a stale view and must never silently retarget the move.
  if (!isEquivalentPaneKey(candidate.pane, identity.fromPane)) {
    const mismatch = step(
      'old_pane_confirmed',
      false,
      'The given --from-pane does not match the active record pane.',
      `given=${identity.fromPane} actual=${candidate.pane}`
    )
    checklist.push(mismatch)
    return {
      rebound: false,
      member: null,
      checklist,
      blockers: [mismatch],
      warnings: [mismatch.message]
    }
  }
  checklist.push(
    step(
      'old_pane_confirmed',
      true,
      'The given --from-pane matches the active record pane.',
      candidate.pane
    )
  )

  // Why: idempotency — rebinding to the equivalent pane is success, but a
  // terminal replacement on the same pane should still refresh the handle
  // cache. Only a fully identical no-op (no handle update requested) skips
  // the write entirely.
  if (isEquivalentPaneKey(identity.fromPane, identity.toPane)) {
    const wantsHandleUpdate = Boolean(params.terminalId || params.lastSeenHandle)
    checklist.push(
      step(
        'new_pane_available',
        true,
        'Target pane is equivalent to the source pane.',
        identity.toPane
      )
    )
    checklist.push(
      step('record_still_active', true, 'The record is active on its current pane.', candidate.id)
    )
    if (!wantsHandleUpdate) {
      return {
        rebound: true,
        member: candidate,
        checklist,
        blockers: [],
        warnings: ['Idempotent rebind: source and target pane are equivalent; no write performed.']
      }
    }
    const refreshed = db.rebindRoleRosterPane(candidate.id, {
      pane: candidate.pane,
      terminalId: params.terminalId,
      lastSeenHandle: params.lastSeenHandle
    })
    if (!refreshed) {
      const lost = step(
        'record_still_active',
        false,
        'The record could not be refreshed; it may have been retired concurrently.',
        candidate.id
      )
      checklist[checklist.length - 1] = lost
      return {
        rebound: false,
        member: null,
        checklist,
        blockers: [lost],
        warnings: [lost.message]
      }
    }
    return {
      rebound: true,
      member: refreshed,
      checklist,
      blockers: [],
      warnings: ['Handle cache refreshed on the same pane.']
    }
  }

  // Why: the target pane must not hold ANY active roster record, regardless of
  // identity or kind. Moving a supervisor onto a worker pane would grant
  // reverse/upper-report authority for that pane. The check spans every role
  // and every run because pane authority is pane-scoped, not identity-scoped.
  const occupants = db.listActiveRoleRostersByPane(identity.toPane)
  if (occupants.length > 0) {
    const label = occupants.map((row) => `${row.role}/${row.kind}@${row.run_id}`).join(', ')
    checklist.push(
      step(
        'new_pane_available',
        false,
        `The target pane is already held by ${occupants.length} active roster record(s): ${label}.`,
        occupants.map((row) => row.id).join(', ')
      )
    )
    const blockers = checklist.filter((entry) => !entry.passed)
    return {
      rebound: false,
      member: null,
      checklist,
      blockers,
      warnings: blockers.map((entry) => entry.message)
    }
  }
  checklist.push(
    step(
      'new_pane_available',
      true,
      'The target pane is free of active roster records.',
      identity.toPane
    )
  )

  // Why: record_still_active is enforced atomically by the DB UPDATE
  // (WHERE status='active' + changes() check). The checklist step reports the
  // write outcome instead of a pre-write dead branch.
  checklist.push(
    step(
      'record_still_active',
      true,
      'The record is active and eligible for a pane move.',
      candidate.id
    )
  )

  const rebound = db.rebindRoleRosterPane(candidate.id, {
    pane: identity.toPane,
    terminalId: params.terminalId,
    lastSeenHandle: params.lastSeenHandle
  })

  if (!rebound) {
    // Why: the DB UPDATE returned changes=0 — the record was retired or moved
    // between the checklist and the write. Surface it instead of pretending.
    const lost = step(
      'record_still_active',
      false,
      'The record could not be rebound; it may have been retired concurrently.',
      candidate.id
    )
    checklist[checklist.length - 1] = lost
    return {
      rebound: false,
      member: null,
      checklist,
      blockers: [lost],
      warnings: [lost.message]
    }
  }

  return {
    rebound: true,
    member: rebound,
    checklist,
    blockers: [],
    warnings: []
  }
}
