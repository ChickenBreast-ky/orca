import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalBoolean, OptionalString, requiredString } from '../schemas'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import {
  listRoleRosterMembers,
  resolveRoleRosterMember,
  showRoleRosterMember,
  summarizeRoleRoster,
  type RoleRosterQueryRuntime
} from '../../orchestration/role-roster-query'
import { retireRoleRosterMember } from '../../orchestration/role-roster-retire'

import { rebindRoleRosterMember } from '../../orchestration/role-roster-rebind'

const RosterListParams = z.object({
  worktree: OptionalString,
  project: OptionalString,
  board: OptionalString,
  role: OptionalString,
  run: OptionalString,
  status: z.enum(['active', 'inactive', 'retired']).optional()
})

// Why: card 8 — retiring needs the full identity (project+board+role+stable
// pane+run) plus the card it closes. A title, an old handle, or "the first
// candidate" is never enough to decide whose session is being settled.
const RosterRetireParams = z.object({
  project: requiredString('Missing --project'),
  board: requiredString('Missing --board'),
  role: requiredString('Missing --role'),
  pane: requiredString('Missing --pane'),
  run: requiredString('Missing --run'),
  task: requiredString('Missing --task'),
  dirtyChangesMoved: OptionalBoolean,
  dirtyChangesEvidence: OptionalString
})

const RosterIdentityParams = z.object({
  project: requiredString('Missing --project'),
  board: requiredString('Missing --board'),
  role: requiredString('Missing --role'),
  run: OptionalString
})

const RosterRebindParams = z.object({
  project: requiredString('Missing --project'),
  board: requiredString('Missing --board'),
  role: requiredString('Missing --role'),
  fromPane: requiredString('Missing --from-pane'),
  toPane: requiredString('Missing --to-pane'),
  run: requiredString('Missing --run'),
  terminalId: OptionalString,
  lastSeenHandle: OptionalString
})

const RosterSummaryParams = z.object({
  all: OptionalBoolean,
  project: OptionalString,
  board: OptionalString
})

// Why: the roster query boundary resolves handles live from the stable pane
// (never from a stored handle or title) and reads model/state only from
// runtime-observed agent status; unknown values stay null.
function rosterQueryRuntime(runtime: OrcaRuntimeService): RoleRosterQueryRuntime {
  return {
    resolveCurrentPaneHandle: (paneKey) => runtime.resolveTerminalPane(paneKey).handle,
    getPaneFacts: (paneKey) => runtime.getAgentStatusSummaryForPaneKey(paneKey)
  }
}

export const ORCHESTRATION_ROSTER_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.rosterList',
    params: RosterListParams,
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      // Why: roster rows may store either the managed worktree id (worker-start)
      // or the raw CLI selector (terminal create); resolve the selector when
      // possible and match either exact value — never a fuzzy guess.
      let worktreeId: string | undefined
      if (params.worktree) {
        try {
          worktreeId = (await runtime.showManagedWorktree(params.worktree)).id
        } catch {
          worktreeId = undefined
        }
      }
      const members = listRoleRosterMembers({
        db,
        runtime: rosterQueryRuntime(runtime),
        filter: {
          status: params.status,
          runId: params.run,
          project: params.project,
          board: params.board,
          role: params.role,
          worktree: params.worktree,
          worktreeId
        }
      })
      return { members }
    }
  }),
  defineMethod({
    name: 'orchestration.rosterShow',
    params: RosterIdentityParams,
    handler: async (params, { runtime }) => {
      const member = showRoleRosterMember({
        db: runtime.getOrchestrationDb(),
        runtime: rosterQueryRuntime(runtime),
        identity: {
          project: params.project,
          board: params.board,
          role: params.role,
          runId: params.run
        }
      })
      return { member }
    }
  }),
  defineMethod({
    name: 'orchestration.rosterResolve',
    params: RosterIdentityParams,
    handler: async (params, { runtime }) => {
      const { member, handleRefreshed } = resolveRoleRosterMember({
        db: runtime.getOrchestrationDb(),
        runtime: rosterQueryRuntime(runtime),
        identity: {
          project: params.project,
          board: params.board,
          role: params.role,
          runId: params.run
        }
      })
      return {
        member,
        handleRefreshed,
        currentHandle: member.currentHandle,
        live: member.live
      }
    }
  }),
  defineMethod({
    name: 'orchestration.rosterRetire',
    params: RosterRetireParams,
    handler: async (params, { runtime }) => {
      // Why: blockers come back as data, not as a thrown error — the caller
      // needs the whole checklist to fix the card close, and nothing is killed
      // or deleted here either way.
      const result = retireRoleRosterMember({
        db: runtime.getOrchestrationDb(),
        identity: {
          project: params.project,
          board: params.board,
          role: params.role,
          pane: params.pane,
          runId: params.run
        },
        taskId: params.task,
        dirtyChangesMoved: params.dirtyChangesMoved === true,
        dirtyChangesEvidence: params.dirtyChangesEvidence
      })
      return result
    }
  }),
  defineMethod({
    name: 'orchestration.rosterRebind',
    params: RosterRebindParams,
    handler: async (params, { runtime }) => {
      // Why: like retire, blockers come back as data so the caller sees the
      // full checklist. A failed rebind never stops a terminal or mutates state.
      return rebindRoleRosterMember({
        db: runtime.getOrchestrationDb(),
        identity: {
          project: params.project,
          board: params.board,
          role: params.role,
          fromPane: params.fromPane,
          toPane: params.toPane,
          runId: params.run
        },
        terminalId: params.terminalId,
        lastSeenHandle: params.lastSeenHandle
      })
    }
  }),
  defineMethod({
    name: 'orchestration.rosterSummary',
    params: RosterSummaryParams,
    handler: async (params, { runtime }) => {
      if (!params.all && !params.project && !params.board) {
        throw new OrchestrationError(
          'invalid_argument',
          'roster summary requires --all or a --project/--board scope.'
        )
      }
      const summary = summarizeRoleRoster({
        db: runtime.getOrchestrationDb(),
        runtime: rosterQueryRuntime(runtime),
        filter: { project: params.project, board: params.board }
      })
      return { summary }
    }
  })
]
