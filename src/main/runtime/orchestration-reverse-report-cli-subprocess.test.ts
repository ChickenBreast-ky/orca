import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

// Why: card 7 R2 — verify each reverse_report_* error code passes through
// the real built CLI as its stable code, not a generic runtime_error. Uses
// the same QA contract as the upper-report subprocess test.
const CLI_PATH = join(process.cwd(), 'out', 'cli', 'index.js')
const QA_USER_DATA_PATH = join(
  homedir(),
  'Library',
  'Application Support',
  'Orca Kyle QA',
  'candidate',
  'c7-reverse-r2'
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

describeIfBuilt('card 7 reverse report error codes through the built CLI', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let server: OrcaRuntimeRpcServer
  let runProjId: string
  let runSuperId: string
  const superPane = 'tab_super:33333333-3333-4333-8333-333333333333'
  const projPane = 'tab_proj:22222222-2222-4222-8222-222222222222'

  beforeEach(async () => {
    mkdirSync(QA_USER_DATA_PATH, { recursive: true, mode: 0o700 })
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => {
      if (handle === 'term_super') {
        return superPane
      }
      if (handle === 'term_proj_sup') {
        return projPane
      }
      return null
    })
    vi.spyOn(runtime, 'resolveTerminalPane').mockImplementation((paneKey: string) => {
      if (paneKey === projPane) {
        return { handle: 'term_proj_live' } as never
      }
      throw new Error('terminal_not_found')
    })
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    runProjId = db.createRun({
      objective: 'project run',
      coordinatorHandle: 'term_proj_sup',
      coordinatorPaneKey: projPane
    }).id
    runSuperId = db.createRun({
      objective: 'super run',
      coordinatorHandle: 'term_super',
      coordinatorPaneKey: 'tab_super_coord:44444444-4444-4444-8444-444444444444'
    }).id
    db.createRoleRoster({
      pane: projPane,
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

  function reversePayload(overrides?: Record<string, unknown>) {
    return JSON.stringify({
      superReply: true,
      targetRunId: runProjId,
      reply: 'card 7 ack',
      ...overrides
    })
  }

  async function sendReverse(args: string[]) {
    return runBuiltCli([
      'orchestration',
      'send',
      '--from',
      'term_super',
      '--type',
      'status',
      ...args,
      '--payload',
      reversePayload(),
      '--json'
    ])
  }

  // (1) honest reverse report delivers to project Run Delivery via CLI
  it('delivers a reverse report to the project Run via --to run:', async () => {
    const send = await sendReverse(['--to', `run:${runProjId}`, '--subject', 'super reply'])
    expect(send.exitCode, `${send.stdout}\n${send.stderr}`).toBe(0)
    const mailbox = db.getRunMailboxHistory(runProjId)
    expect(mailbox).toHaveLength(1)
    expect(mailbox[0].run_id).toBe(runProjId)
    expect(mailbox[0].to_handle).toBe(`run:${runProjId}`)
  }, 30_000)

  // (2) omitting --to still routes to targetRunId
  it('routes to targetRunId even without --to', async () => {
    const send = await sendReverse(['--subject', 'no --to'])
    expect(send.exitCode, `${send.stdout}\n${send.stderr}`).toBe(0)
    const mailbox = db.getRunMailboxHistory(runProjId)
    expect(mailbox).toHaveLength(1)
    expect(mailbox[0].to_handle).toBe(`run:${runProjId}`)
  }, 30_000)

  // (3) reverse_report_malformed passes through as stable code
  it('passes reverse_report_malformed through the CLI as a stable code', async () => {
    const send = await runBuiltCli([
      'orchestration',
      'send',
      '--from',
      'term_super',
      '--to',
      `run:${runProjId}`,
      '--type',
      'status',
      '--subject',
      'malformed',
      '--payload',
      JSON.stringify({ superReply: true }),
      '--json'
    ])
    expect(send.exitCode).toBe(1)
    expect(`${send.stdout}\n${send.stderr}`).toContain('reverse_report_malformed')
    expect(`${send.stdout}\n${send.stderr}`).not.toContain('runtime_error')
  }, 30_000)

  // (4) reverse_report_forbidden passes through as stable code
  it('passes reverse_report_forbidden through the CLI as a stable code', async () => {
    const send = await runBuiltCli([
      'orchestration',
      'send',
      '--from',
      'term_stranger',
      '--to',
      `run:${runProjId}`,
      '--type',
      'status',
      '--subject',
      'unauthorized',
      '--payload',
      reversePayload(),
      '--json'
    ])
    expect(send.exitCode).toBe(1)
    expect(`${send.stdout}\n${send.stderr}`).toContain('reverse_report_forbidden')
    expect(`${send.stdout}\n${send.stderr}`).not.toContain('runtime_error')
  }, 30_000)

  // (5) reverse_report_source_run_invalid passes through as stable code
  it('passes reverse_report_source_run_invalid through the CLI as a stable code', async () => {
    // Why: roster exists for sender pane but points to a non-existent Run
    db.createRoleRoster({
      pane: 'tab_ghost:55555555-5555-4555-8555-555555555555',
      project: 'proj',
      board: 'board_a',
      role: 'ghost_supervisor',
      runId: 'run_does_not_exist_at_all',
      kind: 'supervisor'
    })
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_ghost' ? 'tab_ghost:55555555-5555-4555-8555-555555555555' : null
    )
    const send = await runBuiltCli([
      'orchestration',
      'send',
      '--from',
      'term_ghost',
      '--to',
      `run:${runProjId}`,
      '--type',
      'status',
      '--subject',
      'bad source run',
      '--payload',
      reversePayload(),
      '--json'
    ])
    expect(send.exitCode).toBe(1)
    expect(`${send.stdout}\n${send.stderr}`).toContain('reverse_report_source_run_invalid')
    expect(`${send.stdout}\n${send.stderr}`).not.toContain('runtime_error')
  }, 30_000)

  // (6) reverse_report_target_run_invalid passes through as stable code
  it('passes reverse_report_target_run_invalid through the CLI as a stable code', async () => {
    const send = await runBuiltCli([
      'orchestration',
      'send',
      '--from',
      'term_super',
      '--to',
      `run:${runProjId}`,
      '--type',
      'status',
      '--subject',
      'bad target run',
      '--payload',
      reversePayload({ targetRunId: 'run_does_not_exist' }),
      '--json'
    ])
    expect(send.exitCode).toBe(1)
    expect(`${send.stdout}\n${send.stderr}`).toContain('reverse_report_target_run_invalid')
    expect(`${send.stdout}\n${send.stderr}`).not.toContain('runtime_error')
  }, 30_000)

  // (7) reverse_report_same_run passes through as stable code
  it('passes reverse_report_same_run through the CLI as a stable code', async () => {
    const send = await runBuiltCli([
      'orchestration',
      'send',
      '--from',
      'term_super',
      '--to',
      `run:${runSuperId}`,
      '--type',
      'status',
      '--subject',
      'same run',
      '--payload',
      reversePayload({ targetRunId: runSuperId }),
      '--json'
    ])
    expect(send.exitCode).toBe(1)
    expect(`${send.stdout}\n${send.stderr}`).toContain('reverse_report_same_run')
    expect(`${send.stdout}\n${send.stderr}`).not.toContain('runtime_error')
  }, 30_000)
})
