import { isEquivalentPaneKey, type OrchestrationDb } from './db'
import type { RoleRosterRow } from './types'

// Why: card 8 — worker/reviewer sessions live for one card. Closing one must
// not lose role + stable pane + run_id + last_seen_handle, otherwise the next
// card mistakes a stale handle for an identity. Retire is the settle step; the
// checklist is what makes it safe to run, and the terminal is never killed here.
export type RoleRosterRetireStepCode =
  | 'single_active_candidate'
  | 'task_completed'
  | 'dirty_changes_moved'
  | 'worker_done_recorded'

export type RoleRosterRetireStep = {
  code: RoleRosterRetireStepCode
  passed: boolean
  message: string
  detail: string | null
}

export type RoleRosterRetireIdentity = {
  project: string
  board: string
  role: string
  pane: string
  runId: string
}

export type RoleRosterRetireResult = {
  retired: boolean
  member: RoleRosterRow | null
  checklist: RoleRosterRetireStep[]
  blockers: RoleRosterRetireStep[]
  warnings: string[]
}

function step(
  code: RoleRosterRetireStepCode,
  passed: boolean,
  message: string,
  detail?: string | null
): RoleRosterRetireStep {
  return { code, passed, message, detail: detail ?? null }
}

// Why: identity is project+board+role+stable pane+run_id. Zero candidates,
// two or more candidates, or a pane that does not match the one live candidate
// all mean "we cannot tell whose session this is" — never fall back to the
// first candidate, the title, or the last seen handle.
function resolveRetireCandidate(
  db: OrchestrationDb,
  identity: RoleRosterRetireIdentity
): { candidate: RoleRosterRow | null; step: RoleRosterRetireStep } {
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
        `pane=${identity.pane}`
      )
    }
  }
  if (actives.length > 1) {
    return {
      candidate: null,
      step: step(
        'single_active_candidate',
        false,
        `${actives.length} active roster records still hold ${label}; refusing to retire one by guess.`,
        actives.map((row) => `${row.id}@${row.pane}`).join(', ')
      )
    }
  }
  if (!isEquivalentPaneKey(actives[0].pane, identity.pane)) {
    return {
      candidate: null,
      step: step(
        'single_active_candidate',
        false,
        `The active roster record for ${label} sits on a different pane than the one given.`,
        `given=${identity.pane} actual=${actives[0].pane}`
      )
    }
  }
  return {
    candidate: actives[0],
    step: step(
      'single_active_candidate',
      true,
      `Exactly one active roster record holds ${label} on pane ${actives[0].pane}.`,
      actives[0].id
    )
  }
}

export function retireRoleRosterMember(params: {
  db: OrchestrationDb
  identity: RoleRosterRetireIdentity
  taskId: string
  dirtyChangesMoved: boolean
  dirtyChangesEvidence?: string
}): RoleRosterRetireResult {
  const { db, identity } = params
  const resolved = resolveRetireCandidate(db, identity)
  const checklist: RoleRosterRetireStep[] = [resolved.step]

  // Why: a blocked identity check stops here — the remaining steps describe a
  // specific record and would be meaningless without one.
  if (!resolved.candidate) {
    return {
      retired: false,
      member: null,
      checklist,
      blockers: [resolved.step],
      warnings: [resolved.step.message]
    }
  }
  const candidate = resolved.candidate

  const task = db.getTask(params.taskId)
  if (!task) {
    checklist.push(
      step('task_completed', false, `Task ${params.taskId} was not found.`, 'task missing')
    )
  } else if (task.run_id !== candidate.run_id) {
    checklist.push(
      step(
        'task_completed',
        false,
        `Task ${params.taskId} belongs to a different Run than the roster record.`,
        `task run=${task.run_id} roster run=${candidate.run_id}`
      )
    )
  } else if (task.status !== 'completed') {
    checklist.push(
      step(
        'task_completed',
        false,
        `Task ${params.taskId} is still in progress; a running card keeps its session.`,
        `status=${task.status}`
      )
    )
  } else {
    checklist.push(
      step('task_completed', true, `Task ${params.taskId} is completed.`, `status=${task.status}`)
    )
  }

  // Why: the caller must say out loud that dirty work already moved into an
  // evidence file or checkpoint commit; a bare boolean with no reference is not
  // an explicit confirmation.
  const evidence = params.dirtyChangesEvidence?.trim()
  if (!params.dirtyChangesMoved || !evidence) {
    checklist.push(
      step(
        'dirty_changes_moved',
        false,
        'Dirty changes were not explicitly confirmed as moved into an evidence file or checkpoint commit.',
        params.dirtyChangesMoved ? 'confirmation given without a reference' : 'no confirmation'
      )
    )
  } else {
    checklist.push(
      step('dirty_changes_moved', true, 'Dirty changes were confirmed as moved.', evidence)
    )
  }

  // Why: only a lifecycle-reconciled, authority-verified worker_done counts —
  // a rejected or unauthorized report must not close the session.
  const workerDone = db.findOfficialWorkerDoneForTask({
    runId: candidate.run_id,
    taskId: params.taskId
  })
  if (workerDone.length === 0) {
    checklist.push(
      step(
        'worker_done_recorded',
        false,
        `Run ${candidate.run_id} has no official worker_done for task ${params.taskId}.`,
        'expected at least one worker_done message in the same Run'
      )
    )
  } else {
    checklist.push(
      step(
        'worker_done_recorded',
        true,
        `Run ${candidate.run_id} recorded worker_done for task ${params.taskId}.`,
        workerDone.map((message) => message.id).join(', ')
      )
    )
  }

  const blockers = checklist.filter((entry) => !entry.passed)
  if (blockers.length > 0) {
    // Why: report every failing condition at once so the supervisor fixes the
    // card close in one pass, and leave the roster row exactly as it was.
    return {
      retired: false,
      member: null,
      checklist,
      blockers,
      warnings: blockers.map((entry) => entry.message)
    }
  }

  return {
    retired: true,
    member: db.retireRoleRoster(candidate.id) ?? null,
    checklist,
    blockers: [],
    warnings: []
  }
}
