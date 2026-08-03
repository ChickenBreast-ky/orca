import { isEquivalentPaneKey, type OrchestrationDb } from './db'
import { OrchestrationError } from './orchestration-error'

// Why: card 7 super-to-project reverse reply. A structured signal
// (type=status + payload.superReply=true) routes a supervisor reply into
// the correct project Run Delivery instead of screen injection.
export type ValidatedReverseReport = {
  sourceRunId: string
  targetRunId: string
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

// Why: only the exact structured envelope opts in; every other status
// message keeps the legacy terminal-handle push-on-idle behavior untouched.
export function isReverseReportMessage(type: string, payload: unknown): boolean {
  return (
    type === 'status' &&
    Boolean(payload) &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    (payload as { superReply?: unknown }).superReply === true
  )
}

export function validateReverseReport(params: {
  db: OrchestrationDb
  payload: Record<string, unknown>
  senderPaneKey: string | undefined
}): ValidatedReverseReport {
  const { db, payload } = params

  if (payload.superReply !== true || !isNonEmptyString(payload.targetRunId)) {
    throw new OrchestrationError(
      'reverse_report_malformed',
      'A reverse report requires superReply=true and targetRunId.'
    )
  }

  if (!params.senderPaneKey) {
    throw new OrchestrationError(
      'reverse_report_forbidden',
      'The sender has no stable pane identity.'
    )
  }

  // Why: find the sender source Run from active supervisor roster records
  // matching the sender pane (by stable leaf), not from the Run
  // coordinator_pane_key, so a tab break-out never loses authority.
  const senderRosters = db
    .listRoleRosters({ status: 'active' })
    .filter(
      (roster) =>
        roster.kind === 'supervisor' &&
        isEquivalentPaneKey(roster.pane, params.senderPaneKey as string)
    )
  // Why: require exactly one roster row — two candidates in the same Run are
  // just as ambiguous as two in different Runs; deduplicating by run_id would
  // silently accept the duplicate.
  if (senderRosters.length === 0) {
    throw new OrchestrationError(
      'reverse_report_forbidden',
      'The sender pane holds no active supervisor role in any Run.'
    )
  }
  if (senderRosters.length > 1) {
    throw new OrchestrationError(
      'reverse_report_forbidden',
      'The sender pane holds multiple active supervisor roster records; refusing to auto-select.'
    )
  }

  const sourceRun = db.getRun(senderRosters[0].run_id)
  if (!sourceRun || sourceRun.legacy === 1) {
    throw new OrchestrationError(
      'reverse_report_source_run_invalid',
      'The sender source Run was not found or is legacy.'
    )
  }

  // Why: the target Run must exist and be non-legacy so the reply enters a
  // real project Run Delivery, not a legacy sink.
  const targetRun = db.getRun(payload.targetRunId as string)
  if (!targetRun || targetRun.legacy === 1) {
    throw new OrchestrationError(
      'reverse_report_target_run_invalid',
      `Reverse report target Run ${payload.targetRunId} was not found.`
    )
  }

  // Why: a reverse report must cross Run boundaries; same-Run is an
  // ordinary status that stays on the terminal-handle path.
  if (targetRun.id === sourceRun.id) {
    throw new OrchestrationError(
      'reverse_report_same_run',
      'A reverse report must target a different Run from the sender.'
    )
  }

  return { sourceRunId: sourceRun.id, targetRunId: targetRun.id }
}
