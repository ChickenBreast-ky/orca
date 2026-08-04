import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'

type RosterMember = {
  id: string
  pane: string
  worktree: string | null
  project: string
  board: string
  role: string
  runId: string
  kind: string
  status: string
  lifecycle: 'active' | 'stale' | 'inactive' | 'retired'
  live: boolean
  cleanupCandidate: boolean
  currentHandle: string | null
  lastSeenHandle: string | null
  model: string | null
  agentState: string | null
  title: string | null
  updatedAt: string
}

type RosterSummary = {
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
    lifecycle: string
  }[]
}

function formatMember(member: RosterMember): string {
  const handle = member.currentHandle ?? '(no live terminal)'
  const model = member.model ?? 'unknown'
  const state = member.agentState ? ` state=${member.agentState}` : ''
  return (
    `${member.id} ${member.project}/${member.board}/${member.role} run=${member.runId}\n` +
    `  pane=${member.pane} handle=${handle} lifecycle=${member.lifecycle} kind=${member.kind}${state}\n` +
    `  model=${model} cachedHandle=${member.lastSeenHandle ?? 'none'} updated=${member.updatedAt}`
  )
}

type RetireStep = {
  code: string
  passed: boolean
  message: string
  detail: string | null
}

type RetireResult = {
  retired: boolean
  member: { id: string; pane: string; run_id: string; last_seen_handle: string | null } | null
  checklist: RetireStep[]
  blockers: RetireStep[]
  warnings: string[]
}

type RebindResult = {
  rebound: boolean
  member: {
    id: string
    pane: string
    run_id: string
    terminal_id: string | null
    last_seen_handle: string | null
    status: string
  } | null
  checklist: RetireStep[]
  blockers: RetireStep[]
  warnings: string[]
}

function formatRetire(result: RetireResult): string {
  const lines = result.checklist.map(
    (step) => `  ${step.passed ? 'ok  ' : 'stop'} ${step.code}: ${step.message}`
  )
  if (!result.retired) {
    return [
      `Not retired — ${result.blockers.length} condition(s) blocked the card close.`,
      ...lines,
      'The roster record was left untouched; no terminal was stopped.'
    ].join('\n')
  }
  const member = result.member
  return [
    `Retired ${member?.id ?? 'record'} (pane=${member?.pane ?? '?'} run=${member?.run_id ?? '?'}).`,
    ...lines,
    `History kept: cachedHandle=${member?.last_seen_handle ?? 'none'}; excluded from active resolve from now on.`
  ].join('\n')
}

function formatRebind(result: RebindResult): string {
  const lines = result.checklist.map(
    (step) => `  ${step.passed ? 'ok  ' : 'stop'} ${step.code}: ${step.message}`
  )
  if (!result.rebound) {
    return [
      `Not rebound — ${result.blockers.length} condition(s) blocked the pane move.`,
      ...lines,
      'The roster record was left untouched; no terminal was stopped.'
    ].join('\n')
  }
  const member = result.member
  const idempotent = result.warnings.length > 0 ? ` ${result.warnings[0]}` : ''
  return [
    `Rebound ${member?.id ?? 'record'} to pane=${member?.pane ?? '?'} run=${member?.run_id ?? '?'} (status=${member?.status ?? '?'}).`,
    ...lines,
    `Handle cache: terminal=${member?.terminal_id ?? 'unchanged'} cachedHandle=${member?.last_seen_handle ?? 'none'}.${idempotent}`
  ].join('\n')
}

function formatSummary(summary: RosterSummary): string {
  const scope =
    summary.scope.project || summary.scope.board
      ? `${summary.scope.project ?? '*'}/${summary.scope.board ?? '*'}`
      : 'all'
  const lines = [
    `Roster summary (${scope})`,
    `Active supervisors: ${summary.activeSupervisors.count}${
      summary.activeSupervisors.roles.length > 0
        ? ` (${summary.activeSupervisors.roles.join(', ')})`
        : ''
    }`,
    `Active coordinators: ${summary.activeCoordinators.count}${
      summary.activeCoordinators.roles.length > 0
        ? ` (${summary.activeCoordinators.roles.join(', ')})`
        : ''
    }`,
    `Workers: live=${summary.workers.live} stale=${summary.workers.stale} settled=${summary.workers.inactive} retired=${summary.workers.retired}`,
    `Totals: active=${summary.totals.active} stale=${summary.totals.stale} inactive=${summary.totals.inactive} retired=${summary.totals.retired}`
  ]
  if (summary.cleanupCandidates.length > 0) {
    lines.push('Cleanup candidates:')
    for (const candidate of summary.cleanupCandidates) {
      lines.push(
        `  ${candidate.id} ${candidate.project}/${candidate.board}/${candidate.role} run=${candidate.runId} lifecycle=${candidate.lifecycle}`
      )
    }
  } else {
    lines.push('Cleanup candidates: none')
  }
  return lines.join('\n')
}

export const ROSTER_HANDLERS: Record<string, CommandHandler> = {
  'roster list': async ({ flags, client, json }) => {
    const result = await client.call<{ members: RosterMember[] }>('orchestration.rosterList', {
      worktree: getOptionalStringFlag(flags, 'worktree'),
      project: getOptionalStringFlag(flags, 'project'),
      board: getOptionalStringFlag(flags, 'board'),
      role: getOptionalStringFlag(flags, 'role'),
      run: getOptionalStringFlag(flags, 'run'),
      status: getOptionalStringFlag(flags, 'status')
    })
    printResult(result, json, (value) =>
      value.members.length === 0
        ? 'No roster members found.'
        : value.members.map(formatMember).join('\n')
    )
  },

  'roster show': async ({ flags, client, json }) => {
    const result = await client.call<{ member: RosterMember }>('orchestration.rosterShow', {
      project: getRequiredStringFlag(flags, 'project'),
      board: getRequiredStringFlag(flags, 'board'),
      role: getRequiredStringFlag(flags, 'role'),
      run: getOptionalStringFlag(flags, 'run')
    })
    printResult(result, json, (value) => formatMember(value.member))
  },

  'roster resolve': async ({ flags, client, json }) => {
    const result = await client.call<{
      member: RosterMember
      currentHandle: string | null
      live: boolean
      handleRefreshed: boolean
    }>('orchestration.rosterResolve', {
      project: getRequiredStringFlag(flags, 'project'),
      board: getRequiredStringFlag(flags, 'board'),
      role: getRequiredStringFlag(flags, 'role'),
      run: getOptionalStringFlag(flags, 'run')
    })
    printResult(result, json, (value) => {
      if (!value.currentHandle) {
        return `${value.member.project}/${value.member.board}/${value.member.role}: no live terminal for pane ${value.member.pane}`
      }
      const refreshed = value.handleRefreshed ? ' (handle cache refreshed)' : ''
      return `${value.member.project}/${value.member.board}/${value.member.role} -> ${value.currentHandle}${refreshed}`
    })
  },

  'roster retire': async ({ flags, client, json }) => {
    const result = await client.call<RetireResult>('orchestration.rosterRetire', {
      project: getRequiredStringFlag(flags, 'project'),
      board: getRequiredStringFlag(flags, 'board'),
      role: getRequiredStringFlag(flags, 'role'),
      pane: getRequiredStringFlag(flags, 'pane'),
      run: getRequiredStringFlag(flags, 'run'),
      task: getRequiredStringFlag(flags, 'task'),
      dirtyChangesMoved: flags.has('dirty-changes-moved') ? true : undefined,
      dirtyChangesEvidence: getOptionalStringFlag(flags, 'dirty-changes-evidence')
    })
    printResult(result, json, formatRetire)
  },

  'roster rebind': async ({ flags, client, json }) => {
    const result = await client.call<RebindResult>('orchestration.rosterRebind', {
      project: getRequiredStringFlag(flags, 'project'),
      board: getRequiredStringFlag(flags, 'board'),
      role: getRequiredStringFlag(flags, 'role'),
      fromPane: getRequiredStringFlag(flags, 'from-pane'),
      toPane: getRequiredStringFlag(flags, 'to-pane'),
      run: getRequiredStringFlag(flags, 'run'),
      terminalId: getOptionalStringFlag(flags, 'terminal-id'),
      lastSeenHandle: getOptionalStringFlag(flags, 'last-seen-handle')
    })
    printResult(result, json, formatRebind)
  },

  'roster summary': async ({ flags, client, json }) => {
    const result = await client.call<{ summary: RosterSummary }>('orchestration.rosterSummary', {
      all: flags.has('all') ? true : undefined,
      project: getOptionalStringFlag(flags, 'project'),
      board: getOptionalStringFlag(flags, 'board')
    })
    printResult(result, json, (value) => formatSummary(value.summary))
  }
}
