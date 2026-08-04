import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')
const guardScript = join(projectDir, '.github/scripts/check-root-directory-entries.sh')
const tempDirs = []

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-root-directory-guard-'))
  tempDirs.push(root)
  git(root, ['init', '--quiet'])
  git(root, ['config', 'user.email', 'root-directory-guard-test@example.com'])
  git(root, ['config', 'user.name', 'Root Directory Guard Test'])
  mkdirSync(join(root, 'config'), { recursive: true })
  writeFileSync(join(root, 'config', 'base.txt'), 'base\n')
  git(root, ['add', '-A'])
  git(root, ['commit', '--quiet', '-m', 'base'])
  return { root, base: git(root, ['rev-parse', 'HEAD']) }
}

function commitFiles(root, files) {
  for (const [relativePath, contents] of files) {
    const target = join(root, relativePath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, contents)
  }
  // Why: git add -A is safe for arbitrary filenames (no shell expansion).
  git(root, ['add', '-A'])
  git(root, ['commit', '--quiet', '-m', 'head'])
  return git(root, ['rev-parse', 'HEAD'])
}

function runGuard({ root, base, head, env }) {
  return spawnSync('bash', [guardScript, base, head], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  })
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true })
  }
})

describe('root directory guard', () => {
  it('allows additions inside an existing top-level directory', () => {
    const fixture = makeFixture()
    const head = commitFiles(fixture.root, [['config/new.txt', 'nested\n']])

    const result = runGuard({ ...fixture, head })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('no new root-level files or folders')
  })

  it('rejects a new root-level file with the landing-page message', () => {
    const fixture = makeFixture()
    const head = commitFiles(fixture.root, [['new-root.md', 'too prominent\n']])

    const result = runGuard({ ...fixture, head })
    const output = `${result.stdout}\n${result.stderr}`

    expect(result.status).toBe(1)
    expect(output).toContain('bloat the GitHub landing page')
    expect(output).toContain('new-root.md')
  })

  it('rejects a new top-level directory', () => {
    const fixture = makeFixture()
    const head = commitFiles(fixture.root, [['new-folder/file.txt', 'too prominent\n']])

    const result = runGuard({ ...fixture, head })
    const output = `${result.stdout}\n${result.stderr}`

    expect(result.status).toBe(1)
    expect(output).toContain('new-folder')
  })

  it('rejects exactly one new entry when an existing Korean root coexists with a new ASCII root', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-root-guard-kr-'))
    tempDirs.push(root)
    git(root, ['init', '--quiet'])
    git(root, ['config', 'user.email', 'kr-test@example.com'])
    git(root, ['config', 'user.name', 'KR Test'])
    mkdirSync(join(root, 'config'), { recursive: true })
    writeFileSync(join(root, 'config', 'base.txt'), 'base\n')
    writeFileSync(join(root, '\uB9B4\uB9AC\uC18C\uC2A4.md'), 'korean root\n')
    git(root, ['add', '--', 'config/base.txt', '\uB9B4\uB9AC\uC18C\uC2A4.md'])
    git(root, ['commit', '--quiet', '-m', 'base'])
    const base = git(root, ['rev-parse', 'HEAD'])

    writeFileSync(join(root, 'ascii-new.txt'), 'ascii\n')
    git(root, ['add', '--', 'ascii-new.txt'])
    git(root, ['commit', '--quiet', '-m', 'head'])
    const head = git(root, ['rev-parse', 'HEAD'])

    const resultC = runGuard({ root, base, head, env: { LC_ALL: 'C' } })
    const outputC = `${resultC.stdout}\n${resultC.stderr}`
    expect(resultC.status).toBe(1)
    expect(outputC).toContain('ascii-new.txt')
    expect(outputC).not.toContain('\uB9B4\uB9AC\uC18C\uC2A4')
    const blockedLinesC = outputC.split('\n').filter((l) => l.startsWith('  '))
    expect(blockedLinesC.length).toBe(1)

    const resultUser = runGuard({ root, base, head, env: {} })
    const outputUser = `${resultUser.stdout}\n${resultUser.stderr}`
    expect(resultUser.status).toBe(1)
    expect(outputUser).toContain('ascii-new.txt')
    expect(outputUser).not.toContain('\uB9B4\uB9AC\uC18C\uC2A4')
    const blockedLinesUser = outputUser.split('\n').filter((l) => l.startsWith('  '))
    expect(blockedLinesUser.length).toBe(1)
  })

  it('rejects new root entries with spaces, leading dashes, and unicode names', () => {
    const fixture = makeFixture()
    const trickyNames = ['file with spaces.txt', '--leading-dash.txt', '\u65E5\u672C\u8A9E.md']
    const files = trickyNames.map((name) => [name, 'tricky\n'])
    const head = commitFiles(fixture.root, files)

    for (const localeEnv of [{ LC_ALL: 'C' }, {}]) {
      const result = runGuard({ ...fixture, head, env: localeEnv })
      const output = `${result.stdout}\n${result.stderr}`
      expect(result.status).toBe(1)
      for (const name of trickyNames) {
        expect(output).toContain(name)
      }
    }
  })

  it('is wired into the PR verify gate', () => {
    const workflow = parse(readFileSync(join(projectDir, '.github/workflows/pr.yml'), 'utf8'))
    const guardJob = workflow.jobs.root_directory_guard
    const guardStep = guardJob.steps.find(
      (step) => step.name === 'Reject new root-level files and folders'
    )

    expect(guardJob.name).toBe('root directory guard')
    expect(guardJob.steps[0].with['fetch-depth']).toBe(0)
    expect(guardStep.run).toContain('.github/scripts/check-root-directory-entries.sh')
    expect(workflow.jobs.verify.needs).toContain('root_directory_guard')
  })
})
