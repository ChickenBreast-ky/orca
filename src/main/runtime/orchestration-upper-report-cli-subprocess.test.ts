import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

// Why: card 7 fix re-proof through the real built CLI. The fork data-path
// guard rejects plain ORCA_USER_DATA_PATH overrides, so the child uses the
// official QA contract (ORCA_KYLE_QA=1 + a candidate dir under the QA root)
// exactly like the card 7 GUI isolation. The QA profile dir is preserved
// after the run (never deleted) per workspace safety rules.
const CLI_PATH = join(process.cwd(), 'out', 'cli', 'index.js')
const QA_USER_DATA_PATH = join(
  homedir(),
  'Library',
  'Application Support',
  'Orca Kyle QA',
  'candidate',
  'card7-fix-upper-report'
)

const describeIfBuilt = existsSync(CLI_PATH) ? describe : describe.skip

function childEnv(): NodeJS.ProcessEnv {
  const scrubbed = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('ORCA_'))
  )
  return {
    ...scrubbed,
    ORCA_KYLE_QA: '1',
    ORCA_KYLE_QA_USER_DATA_PATH: QA_USER_DATA_PATH,
    ORCA_DEV_CLI_INVOCATION: '1'
  }
}

async function runBuiltCli(
  args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [CLI_PATH, ...args], {
    env: childEnv(),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (d) => stdoutChunks.push(d))
  child.stderr.on('data', (d) => stderrChunks.push(d))
  const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
    child.once('exit', (code) => resolveExit(code ?? 1))
    child.once('error', rejectExit)
  })
  return { exitCode, stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') }
}

describeIfBuilt('card 7 upper report through the built CLI', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let server: OrcaRuntimeRpcServer
  let runProjId: string
  let runSuperId: string
  let taskId: string
  let dispatchId: string
  const supPane = 'tab_sup:22222222-2222-4222-8222-222222222222'
  const superPane = 'tab_super:33333333-3333-4333-8333-333333333333'

  beforeEach(async () => {
    mkdirSync(QA_USER_DATA_PATH, { recursive: true, mode: 0o700 })
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_sup' ? supPane : null
    )
    vi.spyOn(runtime, 'resolveTerminalPane').mockImplementation((paneKey: string) => {
      if (paneKey === superPane) {
        return { handle: 'term_super_live' } as never
      }
      throw new Error('terminal_not_found')
    })
    runProjId = db.createRun({
      objective: 'project run',
      coordinatorHandle: 'term_sup',
      coordinatorPaneKey: supPane
    }).id
    runSuperId = db.createRun({
      objective: 'super run',
      coordinatorHandle: 'term_super',
      coordinatorPaneKey: 'tab_super_coord:44444444-4444-4444-8444-444444444444'
    }).id
    const task = db.createTask({ spec: 'card 6 work', runId: runProjId })
    taskId = task.id
    dispatchId = db.createDispatchContext(taskId, 'term_worker', 'tab_worker:leaf_worker').id
    db.createRoleRoster({
      pane: supPane,
      project: 'proj',
      board: 'board_a',
      role: 'supervisor',
      runId: runProjId,
      kind: 'supervisor'
    })
    db.createRoleRoster({
      pane: superPane,
      project: 'proj',
      board: 'board_a',
      role: 'super_supervisor',
      runId: runSuperId,
      kind: 'supervisor'
    })
    server = new OrcaRuntimeRpcServer({ runtime, userDataPath: QA_USER_DATA_PATH })
    await server.start()
  })

  afterEach(async () => {
    await server.stop()
    db.close()
  })

  function upperPayload(overrides?: Record<string, unknown>) {
    return JSON.stringify({
      taskId,
      dispatchId,
      upperReport: true,
      outcome: 'succeeded',
      nextAction: 'dispatch card 7 fix',
      ...overrides
    })
  }

  it('delivers an honest cross-Run report via --to run: and stamps sourceRunId', async () => {
    const send = await runBuiltCli([
      'orchestration',
      'send',
      '--from',
      'term_sup',
      '--to',
      `run:${runSuperId}`,
      '--type',
      'status',
      '--subject',
      'card 6 complete',
      '--payload',
      upperPayload(),
      '--json'
    ])
    expect(send.exitCode, `${send.stdout}\n${send.stderr}`).toBe(0)
    const mailbox = db.getRunMailboxHistory(runSuperId)
    expect(mailbox).toHaveLength(1)
    const storedPayload = JSON.parse(mailbox[0].payload ?? '{}') as Record<string, unknown>
    expect(mailbox[0].run_id).toBe(runSuperId)
    expect(storedPayload.sourceRunId).toBe(runProjId)
    expect(storedPayload.taskId).toBe(taskId)
    expect(storedPayload.dispatchId).toBe(dispatchId)
    expect(db.getRunMailboxHistory(runProjId)).toHaveLength(0)
  }, 30_000)

  it('delivers the same report via --to-role to the single super supervisor', async () => {
    const send = await runBuiltCli([
      'orchestration',
      'send',
      '--from',
      'term_sup',
      '--to-role',
      'super_supervisor',
      '--project',
      'proj',
      '--board',
      'board_a',
      '--run',
      runSuperId,
      '--type',
      'status',
      '--subject',
      'card 6 complete',
      '--payload',
      upperPayload(),
      '--json'
    ])
    expect(send.exitCode, `${send.stdout}\n${send.stderr}`).toBe(0)
    const inbox = db.getAllMessagesForHandle('term_super_live')
    expect(inbox).toHaveLength(1)
    expect(inbox[0].run_id).toBe(runSuperId)
    const storedPayload = JSON.parse(inbox[0].payload ?? '{}') as Record<string, unknown>
    expect(storedPayload.sourceRunId).toBe(runProjId)
  }, 30_000)

  it('rejects a forged dispatchId fail-closed', async () => {
    const send = await runBuiltCli([
      'orchestration',
      'send',
      '--from',
      'term_sup',
      '--to',
      `run:${runSuperId}`,
      '--type',
      'status',
      '--subject',
      'forged',
      '--payload',
      upperPayload({ dispatchId: 'ctx_does_not_exist' }),
      '--json'
    ])
    expect(send.exitCode).toBe(1)
    expect(`${send.stdout}\n${send.stderr}`).toContain('upper_report_dispatch_not_found')
    expect(db.getRunMailboxHistory(runSuperId)).toHaveLength(0)
  }, 30_000)

  it('rejects a malformed envelope missing nextAction fail-closed', async () => {
    const malformed = JSON.parse(upperPayload()) as Record<string, unknown>
    delete malformed.nextAction
    const send = await runBuiltCli([
      'orchestration',
      'send',
      '--from',
      'term_sup',
      '--to',
      `run:${runSuperId}`,
      '--type',
      'status',
      '--subject',
      'malformed',
      '--payload',
      JSON.stringify(malformed),
      '--json'
    ])
    expect(send.exitCode).toBe(1)
    expect(`${send.stdout}\n${send.stderr}`).toContain('upper_report_malformed')
    expect(db.getRunMailboxHistory(runSuperId)).toHaveLength(0)
  }, 30_000)
})
