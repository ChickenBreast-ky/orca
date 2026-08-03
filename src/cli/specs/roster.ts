import { GLOBAL_FLAGS, type CommandSpec } from '../args'

// Why: card 3 — official role roster queries. Identity is
// project+board+role(+Run); handles shown are resolved live from the stable
// pane and last_seen_handle is a cache, never the selection input.
export const ROSTER_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['roster', 'list'],
    summary: 'List role roster members with live pane-resolved handles',
    usage:
      'orca roster list [--worktree <selector>] [--project <project>] [--board <board>] [--role <role>] [--run <run_id>] [--status <active|inactive|retired>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'project', 'board', 'role', 'run', 'status'],
    notes: [
      'Each row reports the live runtime handle resolved from the stable pane plus status, model, and lifecycle (active/stale/inactive/retired).',
      'Retired members stay listed with their pane, run, and cached handle as history; they never appear as active candidates.',
      '--worktree matches the managed worktree id or the exact selector stored at creation; it never fuzzy-matches.'
    ]
  },
  {
    path: ['roster', 'show'],
    summary: 'Show the single active roster member for a role identity',
    usage:
      'orca roster show --project <project> --board <board> --role <role> [--run <run_id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'project', 'board', 'role', 'run'],
    notes: [
      'Zero active candidates is an explicit not-found error; two or more is an explicit ambiguity and is never auto-selected.',
      'A stale last_seen_handle cache is refreshed from the live pane only when exactly one candidate matches.'
    ]
  },
  {
    path: ['roster', 'resolve'],
    summary: 'Resolve the current live handle for a role identity',
    usage:
      'orca roster resolve --project <project> --board <board> --role <role> [--run <run_id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'project', 'board', 'role', 'run'],
    notes: [
      'Returns the current runtime handle for the single matching active record; when no live terminal exists the handle is null instead of a guess.',
      'Title and stored handles are never tried first and never used as a fallback.'
    ]
  },
  {
    path: ['roster', 'retire'],
    summary: 'Retire a finished card-scoped worker/reviewer roster record',
    usage:
      'orca roster retire --project <project> --board <board> --role <role> --pane <pane_key> --run <run_id> --task <task_id> --dirty-changes-moved --dirty-changes-evidence <path_or_commit> [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'project',
      'board',
      'role',
      'pane',
      'run',
      'task',
      'dirty-changes-moved',
      'dirty-changes-evidence'
    ],
    notes: [
      'Runs the card-close checklist in order: one active candidate for the identity, the task is completed, dirty changes were explicitly confirmed as moved to an evidence file or checkpoint commit, and the same Run recorded an official worker_done.',
      'Any failing condition returns the whole checklist with warnings and stop reasons and leaves the record untouched; nothing is deleted and no terminal is stopped or killed.',
      'Retiring keeps role, stable pane, run, and last_seen_handle as history while removing the record from every active-candidate resolution.'
    ]
  },
  {
    path: ['roster', 'summary'],
    summary: 'Summarize active supervisors, workers, and cleanup candidates',
    usage: 'orca roster summary --all [--project <project>] [--board <board>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'all', 'project', 'board'],
    notes: [
      'Requires --all or a --project/--board scope.',
      'Stale active records (pane no longer live) and inactive records are listed as cleanup candidates, distinct from live members.'
    ]
  }
]
