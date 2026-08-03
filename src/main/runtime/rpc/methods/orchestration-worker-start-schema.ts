import { z } from 'zod'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'
import { RoleRosterCreateParamsSchema } from '../../orchestration/role-roster-creation'

export const WorkerStartParams = z.object({
  task: requiredString('Missing --task'),
  on: OptionalString,
  run: OptionalString,
  from: requiredString('Missing --from'),
  worktree: OptionalString,
  name: OptionalString,
  repo: OptionalString,
  baseBranch: OptionalString,
  displayName: OptionalString,
  comment: OptionalString,
  setup: z.enum(['run', 'skip', 'inherit']).optional(),
  terminal: OptionalString,
  agent: OptionalString,
  retryOf: OptionalString,
  timeoutMs: OptionalFiniteNumber,
  devMode: z.boolean().optional(),
  // Why: card 2 — when the coordinator supplies role input, the started
  // worker leaves an official role_roster record; runId defaults to the
  // worker's Run.
  roleRoster: RoleRosterCreateParamsSchema.optional()
})

export type WorkerStartInput = z.infer<typeof WorkerStartParams>
