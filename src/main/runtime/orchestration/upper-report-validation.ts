import { isEquivalentPaneKey, type OrchestrationDb } from './db'
import { OrchestrationError } from './orchestration-error'

// Why: card 7 fix — a structured upper report (type=status +
// payload.upperReport=true) carries a project task+dispatch as provenance
// data, not as a routing anchor, so it may cross into the named super Run.
// The server re-proves every field against the DB and the sender's stable
// pane/role authority; raw payload claims alone never pass. Title,
// last_seen_handle, and cached handles are never consulted.
export type ValidatedUpperReport = {
  taskId: string
  dispatchId: string
  sourceRunId: string
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

// Why: only the exact structured envelope opts in; every other status
// message keeps the legacy dispatchId-as-anchor behavior untouched.
export function isUpperReportMessage(type: string, payload: unknown): boolean {
  return (
    type === 'status' &&
    Boolean(payload) &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    (payload as { upperReport?: unknown }).upperReport === true
  )
}

export function validateUpperReport(params: {
  db: OrchestrationDb
  payload: Record<string, unknown>
  senderPaneKey: string | undefined
}): ValidatedUpperReport {
  const { db, payload } = params
  const taskId = payload.taskId
  const dispatchId = payload.dispatchId
  const outcome = payload.outcome
  const nextAction = payload.nextAction
  if (
    !isNonEmptyString(taskId) ||
    !isNonEmptyString(dispatchId) ||
    payload.upperReport !== true ||
    !isNonEmptyString(outcome) ||
    !isNonEmptyString(nextAction)
  ) {
    throw new OrchestrationError(
      'upper_report_malformed',
      'An upper report requires taskId, dispatchId, upperReport=true, outcome, and nextAction.'
    )
  }
  const dispatch = db.getDispatchContextById(dispatchId)
  if (!dispatch) {
    throw new OrchestrationError(
      'upper_report_dispatch_not_found',
      `Upper report Dispatch ${dispatchId} was not found.`
    )
  }
  if (dispatch.task_id !== taskId) {
    throw new OrchestrationError(
      'upper_report_task_mismatch',
      `Upper report Dispatch ${dispatchId} belongs to task ${dispatch.task_id}, not ${taskId}.`
    )
  }
  const sourceRun = db.getRun(dispatch.run_id)
  if (!sourceRun || sourceRun.legacy === 1) {
    throw new OrchestrationError(
      'upper_report_source_run_invalid',
      `Upper report source Run ${dispatch.run_id} was not found.`
    )
  }
  // Why: sender authority is the active project-supervisor roster record for
  // the sender's stable pane inside the provenance Run; anything else (no
  // pane, no roster, wrong Run, non-supervisor kind) fails closed.
  const authorized =
    params.senderPaneKey !== undefined &&
    db
      .listRoleRosters({ runId: sourceRun.id, status: 'active' })
      .some(
        (roster) =>
          roster.kind === 'supervisor' &&
          isEquivalentPaneKey(roster.pane, params.senderPaneKey as string)
      )
  if (!authorized) {
    throw new OrchestrationError(
      'upper_report_forbidden',
      'The sender pane holds no active project-supervisor role in the upper report source Run.'
    )
  }
  return { taskId, dispatchId, sourceRunId: sourceRun.id }
}
