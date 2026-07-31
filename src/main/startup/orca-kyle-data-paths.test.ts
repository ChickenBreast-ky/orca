import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OrcaKyleDataPathIsolationError,
  prepareOrcaKyleUserDataPath,
  resolveOrcaKyleUserDataPath
} from '../../shared/orca-kyle-data-paths'

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-kyle-data-paths-'))
  roots.push(root)
  return root
}

function makeMacPaths(root: string): {
  readonly homeDir: string
  readonly appDataPath: string
  readonly officialUserDataPath: string
} {
  const homeDir = join(root, 'home')
  const appDataPath = join(homeDir, 'Library', 'Application Support')
  return {
    homeDir,
    appDataPath,
    officialUserDataPath: join(appDataPath, 'Orca')
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('resolveOrcaKyleUserDataPath', () => {
  it('uses the packaged Orca Kyle root and a fork-specific dev root', () => {
    const { homeDir, appDataPath } = makeMacPaths(makeRoot())

    const packaged = resolveOrcaKyleUserDataPath({
      appDataPath,
      env: {},
      homeDir,
      isDev: false,
      isPackaged: true,
      platform: 'darwin'
    })
    const development = resolveOrcaKyleUserDataPath({
      appDataPath,
      env: {},
      homeDir,
      isDev: true,
      isPackaged: false,
      platform: 'darwin'
    })

    expect(packaged.userDataPath).toBe(join(appDataPath, 'Orca Kyle'))
    expect(development.userDataPath).toBe(join(appDataPath, 'orca-kyle-dev'))
    expect(development.userDataPath).not.toContain('orca-dev')
  })

  it('accepts a QA candidate only for a local QA launch', () => {
    const { homeDir, appDataPath } = makeMacPaths(makeRoot())
    const candidate = join(appDataPath, 'Orca Kyle QA', 'candidate', 'attempt-1')

    const resolved = resolveOrcaKyleUserDataPath({
      appDataPath,
      env: { ORCA_KYLE_QA: '1', ORCA_KYLE_QA_USER_DATA_PATH: candidate },
      homeDir,
      isDev: true,
      isPackaged: false,
      platform: 'darwin'
    })

    expect(resolved.userDataPath).toBe(candidate)
    expect(resolved.kind).toBe('qa-candidate')
  })

  it('rejects a QA override outside its candidate root', () => {
    const { homeDir, appDataPath } = makeMacPaths(makeRoot())

    expect(() =>
      resolveOrcaKyleUserDataPath({
        appDataPath,
        env: { ORCA_KYLE_QA: '1', ORCA_KYLE_QA_USER_DATA_PATH: join(appDataPath, 'escaped') },
        homeDir,
        isDev: true,
        isPackaged: false,
        platform: 'darwin'
      })
    ).toThrow(OrcaKyleDataPathIsolationError)
  })

  it('rejects a malformed blank QA override', () => {
    const { homeDir, appDataPath } = makeMacPaths(makeRoot())

    expect(() =>
      resolveOrcaKyleUserDataPath({
        appDataPath,
        env: { ORCA_KYLE_QA: '1', ORCA_KYLE_QA_USER_DATA_PATH: '   ' },
        homeDir,
        isDev: true,
        isPackaged: false,
        platform: 'darwin'
      })
    ).toThrow(OrcaKyleDataPathIsolationError)
  })

  it('rejects a QA override for a packaged launch', () => {
    const { homeDir, appDataPath } = makeMacPaths(makeRoot())
    const candidate = join(appDataPath, 'Orca Kyle QA', 'candidate', 'attempt-1')

    expect(() =>
      resolveOrcaKyleUserDataPath({
        appDataPath,
        env: { ORCA_KYLE_QA: '1', ORCA_KYLE_QA_USER_DATA_PATH: candidate },
        homeDir,
        isDev: false,
        isPackaged: true,
        platform: 'darwin'
      })
    ).toThrow(OrcaKyleDataPathIsolationError)
  })
})

describe('prepareOrcaKyleUserDataPath', () => {
  it('creates only a fork-owned root with mode 0700', () => {
    const paths = makeMacPaths(makeRoot())
    const candidate = join(paths.appDataPath, 'Orca Kyle')

    prepareOrcaKyleUserDataPath({
      isQaCandidate: false,
      officialUserDataPath: paths.officialUserDataPath,
      userDataPath: candidate
    })

    expect(statSync(candidate).mode & 0o777).toBe(0o700)
  })

  it('remains safe when preflight is repeated after an interrupted startup', () => {
    const paths = makeMacPaths(makeRoot())
    const candidate = join(paths.appDataPath, 'Orca Kyle')
    const options = {
      isQaCandidate: false,
      officialUserDataPath: paths.officialUserDataPath,
      userDataPath: candidate
    }

    prepareOrcaKyleUserDataPath(options)
    prepareOrcaKyleUserDataPath(options)

    expect(statSync(candidate).mode & 0o777).toBe(0o700)
  })

  it('rejects the official userData root before it can be initialized', () => {
    const paths = makeMacPaths(makeRoot())

    expect(() =>
      prepareOrcaKyleUserDataPath({
        isQaCandidate: false,
        officialUserDataPath: paths.officialUserDataPath,
        userDataPath: paths.officialUserDataPath
      })
    ).toThrow(OrcaKyleDataPathIsolationError)
  })

  it('rejects a candidate symlink that escapes to the official fixture', () => {
    const paths = makeMacPaths(makeRoot())
    mkdirSync(paths.officialUserDataPath, { recursive: true })
    const candidate = join(paths.appDataPath, 'Orca Kyle')
    symlinkSync(paths.officialUserDataPath, candidate)

    expect(() =>
      prepareOrcaKyleUserDataPath({
        isQaCandidate: false,
        officialUserDataPath: paths.officialUserDataPath,
        userDataPath: candidate
      })
    ).toThrow(OrcaKyleDataPathIsolationError)
  })

  it('rejects a QA candidate whose owned parent is a symbolic-link escape', () => {
    const paths = makeMacPaths(makeRoot())
    const qaRoot = join(paths.appDataPath, 'Orca Kyle QA')
    const candidateRoot = join(qaRoot, 'candidate')
    const candidate = join(candidateRoot, 'attempt-1')
    mkdirSync(paths.officialUserDataPath, { recursive: true })
    mkdirSync(paths.appDataPath, { recursive: true })
    symlinkSync(paths.officialUserDataPath, qaRoot)

    expect(() =>
      prepareOrcaKyleUserDataPath({
        isQaCandidate: true,
        officialUserDataPath: paths.officialUserDataPath,
        ownedAncestorPaths: [qaRoot, candidateRoot],
        userDataPath: candidate
      })
    ).toThrow(OrcaKyleDataPathIsolationError)
  })

  it('rejects an unwritable root', () => {
    const paths = makeMacPaths(makeRoot())
    const candidate = join(paths.appDataPath, 'Orca Kyle')
    mkdirSync(candidate, { recursive: true, mode: 0o700 })
    chmodSync(candidate, 0o500)

    expect(() =>
      prepareOrcaKyleUserDataPath({
        isQaCandidate: false,
        officialUserDataPath: paths.officialUserDataPath,
        userDataPath: candidate
      })
    ).toThrow(OrcaKyleDataPathIsolationError)
  })

  it('rejects a regular file where the fork root must be a directory', () => {
    const paths = makeMacPaths(makeRoot())
    const candidate = join(paths.appDataPath, 'Orca Kyle')
    mkdirSync(paths.appDataPath, { recursive: true })
    writeFileSync(candidate, 'not a directory')

    expect(() =>
      prepareOrcaKyleUserDataPath({
        isQaCandidate: false,
        officialUserDataPath: paths.officialUserDataPath,
        userDataPath: candidate
      })
    ).toThrow(OrcaKyleDataPathIsolationError)
  })

  it('rejects a QA candidate hardlink shared with an official fixture file', () => {
    const paths = makeMacPaths(makeRoot())
    const candidate = join(paths.appDataPath, 'Orca Kyle QA', 'candidate', 'attempt-1')
    mkdirSync(paths.officialUserDataPath, { recursive: true })
    mkdirSync(candidate, { recursive: true })
    const officialFile = join(paths.officialUserDataPath, 'orca-data.json')
    writeFileSync(officialFile, 'fixture')
    linkSync(officialFile, join(candidate, 'orca-data.json'))

    expect(() =>
      prepareOrcaKyleUserDataPath({
        isQaCandidate: true,
        officialUserDataPath: paths.officialUserDataPath,
        userDataPath: candidate
      })
    ).toThrow(OrcaKyleDataPathIsolationError)
  })
})
