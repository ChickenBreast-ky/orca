import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'

const ENV_SCHEMA = z.object({
  ORCA_KYLE_QA: z.string().optional(),
  ORCA_KYLE_QA_USER_DATA_PATH: z.string().optional()
})

const MAX_QA_FILE_IDENTITIES = 10_000

export class OrcaKyleDataPathIsolationError extends Error {
  readonly name = 'OrcaKyleDataPathIsolationError'

  constructor(readonly reason: string) {
    super(`Orca Kyle data-path isolation failed: ${reason}`)
  }
}

export type OrcaKyleDataRoots = {
  readonly forkUserDataPath: string
  readonly officialUserDataPath: string
  readonly qaCandidateRootPath: string
  readonly qaRootPath: string
}

type PathKind = 'normal' | 'qa-candidate'

export type OrcaKyleUserDataPath = {
  readonly kind: PathKind
  readonly roots: OrcaKyleDataRoots
  readonly userDataPath: string
}

export type ResolveOrcaKyleUserDataPathOptions = {
  readonly appDataPath: string
  readonly env: NodeJS.ProcessEnv
  readonly homeDir?: string
  readonly isDev: boolean
  readonly isPackaged: boolean
  readonly platform?: NodeJS.Platform
}

export type PrepareOrcaKyleUserDataPathOptions = {
  readonly isQaCandidate: boolean
  readonly ownedAncestorPaths?: readonly string[]
  readonly officialUserDataPath: string
  readonly userDataPath: string
}

type FileIdentity = {
  readonly device: number
  readonly inode: number
}

function dataRootLeaf(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? 'Orca Kyle' : 'orca-kyle'
}

function officialDataRootLeaf(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? 'Orca' : 'orca'
}

export function getOrcaKyleDataRoots({
  appDataPath,
  platform = process.platform
}: Pick<ResolveOrcaKyleUserDataPathOptions, 'appDataPath' | 'platform'>): OrcaKyleDataRoots {
  const forkUserDataPath = join(appDataPath, dataRootLeaf(platform))
  const qaRootPath = join(appDataPath, 'Orca Kyle QA')
  return {
    forkUserDataPath,
    officialUserDataPath: join(appDataPath, officialDataRootLeaf(platform)),
    qaCandidateRootPath: join(qaRootPath, 'candidate'),
    qaRootPath
  }
}

function isDirectQaCandidate(candidatePath: string, candidateRootPath: string): boolean {
  return dirname(candidatePath) === candidateRootPath && candidatePath !== candidateRootPath
}

export function resolveOrcaKyleUserDataPath({
  appDataPath,
  env,
  isDev,
  isPackaged,
  platform = process.platform
}: ResolveOrcaKyleUserDataPathOptions): OrcaKyleUserDataPath {
  const parsedEnv = ENV_SCHEMA.parse(env)
  const roots = getOrcaKyleDataRoots({ appDataPath, platform })
  const qaOverride = parsedEnv.ORCA_KYLE_QA_USER_DATA_PATH
  if (!qaOverride) {
    return {
      kind: 'normal',
      roots,
      userDataPath: isDev ? join(appDataPath, 'orca-kyle-dev') : roots.forkUserDataPath
    }
  }

  if (parsedEnv.ORCA_KYLE_QA !== '1') {
    throw new OrcaKyleDataPathIsolationError('QA override requires ORCA_KYLE_QA=1')
  }
  if (isPackaged || !isDev) {
    throw new OrcaKyleDataPathIsolationError(
      'QA override is unavailable outside an unpackaged local build'
    )
  }

  const candidatePath = resolve(qaOverride)
  const candidateRootPath = resolve(roots.qaCandidateRootPath)
  if (!isDirectQaCandidate(candidatePath, candidateRootPath)) {
    throw new OrcaKyleDataPathIsolationError('QA override is outside the candidate root')
  }
  return { kind: 'qa-candidate', roots, userDataPath: candidatePath }
}

function assertDirectoryIsPrivateAndWritable(directoryPath: string): void {
  const metadata = lstatSync(directoryPath)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new OrcaKyleDataPathIsolationError('userData root is not a real directory')
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new OrcaKyleDataPathIsolationError('userData root permissions are not private')
  }
  if ((metadata.mode & 0o300) !== 0o300) {
    throw new OrcaKyleDataPathIsolationError('userData root is not writable')
  }
  try {
    accessSync(directoryPath, constants.W_OK | constants.X_OK)
  } catch (error) {
    if (error instanceof Error) {
      throw new OrcaKyleDataPathIsolationError('userData root is not writable')
    }
    throw error
  }
}

function getRealPathIfPresent(candidatePath: string): string | null {
  if (!existsSync(candidatePath)) {
    return null
  }
  return realpathSync(candidatePath)
}

function assertOwnedAncestorsAreNotLinks(ownedAncestorPaths: readonly string[]): void {
  for (const ancestorPath of ownedAncestorPaths) {
    if (existsSync(ancestorPath) && lstatSync(ancestorPath).isSymbolicLink()) {
      throw new OrcaKyleDataPathIsolationError(
        'a fork-owned userData ancestor cannot be a symbolic link'
      )
    }
  }
}

function identityKey(identity: FileIdentity): string {
  return `${identity.device}:${identity.inode}`
}

function collectRegularFileIdentities(rootPath: string): Set<string> {
  const identities = new Set<string>()
  const pendingPaths = [rootPath]
  while (pendingPaths.length > 0) {
    const currentPath = pendingPaths.pop()
    if (!currentPath) {
      continue
    }
    for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
      const entryPath = join(currentPath, entry.name)
      if (entry.isSymbolicLink()) {
        throw new OrcaKyleDataPathIsolationError('QA candidate contains a symbolic link')
      }
      if (entry.isDirectory()) {
        pendingPaths.push(entryPath)
        continue
      }
      if (!entry.isFile()) {
        continue
      }
      const metadata = statSync(entryPath)
      identities.add(identityKey({ device: metadata.dev, inode: metadata.ino }))
      if (identities.size > MAX_QA_FILE_IDENTITIES) {
        throw new OrcaKyleDataPathIsolationError(
          'QA candidate identity scan exceeded its safe bound'
        )
      }
    }
  }
  return identities
}

function assertQaCandidateDoesNotShareOfficialFiles(
  candidatePath: string,
  officialUserDataPath: string
): void {
  if (!existsSync(officialUserDataPath)) {
    return
  }
  const officialIdentities = collectRegularFileIdentities(officialUserDataPath)
  const candidateIdentities = collectRegularFileIdentities(candidatePath)
  for (const candidateIdentity of candidateIdentities) {
    if (officialIdentities.has(candidateIdentity)) {
      throw new OrcaKyleDataPathIsolationError(
        'QA candidate shares a file identity with official data'
      )
    }
  }
}

export function prepareOrcaKyleUserDataPath({
  isQaCandidate,
  ownedAncestorPaths = [],
  officialUserDataPath,
  userDataPath
}: PrepareOrcaKyleUserDataPathOptions): void {
  const candidatePath = resolve(userDataPath)
  const officialPath = resolve(officialUserDataPath)
  if (candidatePath === officialPath) {
    throw new OrcaKyleDataPathIsolationError('userData root is the official Orca root')
  }
  assertOwnedAncestorsAreNotLinks(ownedAncestorPaths)

  if (existsSync(candidatePath)) {
    const existingMetadata = lstatSync(candidatePath)
    if (existingMetadata.isSymbolicLink()) {
      throw new OrcaKyleDataPathIsolationError('userData root cannot be a symbolic link')
    }
    if (!existingMetadata.isDirectory()) {
      throw new OrcaKyleDataPathIsolationError('userData root is not a directory')
    }
  }
  mkdirSync(candidatePath, { recursive: true, mode: 0o700 })
  assertDirectoryIsPrivateAndWritable(candidatePath)

  const candidateRealPath = getRealPathIfPresent(candidatePath)
  const officialRealPath = getRealPathIfPresent(officialPath)
  if (
    candidateRealPath !== null &&
    officialRealPath !== null &&
    candidateRealPath === officialRealPath
  ) {
    throw new OrcaKyleDataPathIsolationError('userData root resolves to official Orca data')
  }
  if (isQaCandidate) {
    assertQaCandidateDoesNotShareOfficialFiles(candidatePath, officialPath)
  }
}

export function getDefaultOrcaKyleCliUserDataPath(
  platform: NodeJS.Platform = process.platform,
  homeDir = homedir()
): string {
  const appDataPath =
    platform === 'darwin'
      ? join(homeDir, 'Library', 'Application Support')
      : platform === 'win32'
        ? (process.env.APPDATA ?? join(homeDir, 'AppData', 'Roaming'))
        : process.env.XDG_CONFIG_HOME || join(homeDir, '.config')
  const resolved = resolveOrcaKyleUserDataPath({
    appDataPath,
    env: process.env,
    isDev: process.env.ORCA_DEV_CLI_INVOCATION === '1',
    isPackaged: process.env.ORCA_DEV_CLI_INVOCATION !== '1',
    platform
  })
  const inheritedUserDataPath = process.env.ORCA_USER_DATA_PATH
  if (inheritedUserDataPath && resolve(inheritedUserDataPath) !== resolved.userDataPath) {
    throw new OrcaKyleDataPathIsolationError(
      'inherited userData path does not match the Orca Kyle contract'
    )
  }
  return resolved.userDataPath
}
