#!/usr/bin/env node
// Symlinks the fork-only dev wrapper into the user's local bin directory after
// `pnpm run build:cli`, without touching the upstream Orca command names.
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync } from 'node:fs'
import path from 'node:path'

const scriptDir = import.meta.dirname
const source = path.join(scriptDir, 'orca-dev.mjs')
const commandPath = getCommandPath()

if (!commandPath) {
  console.log('[orca-kyle-dev] Skipping local symlink (unsupported platform).')
  process.exit(0)
}

function isOwnedByUs(target) {
  try {
    if (!lstatSync(target).isSymbolicLink()) {
      return false
    }
    return readlinkSync(target) === source
  } catch {
    return false
  }
}

if (existsSync(commandPath)) {
  if (isOwnedByUs(commandPath)) {
    console.log(`[orca-kyle-dev] ${commandPath} already points to the fork dev CLI.`)
    process.exit(0)
  }
  console.error(
    `[orca-kyle-dev] ${commandPath} exists but is not our symlink. Choose another path before installing the fork dev CLI.`
  )
  process.exit(1)
}

mkdirSync(path.dirname(commandPath), { recursive: true })
symlinkSync(source, commandPath)
console.log(`[orca-kyle-dev] Symlinked ${commandPath} → ${source}`)

function getCommandPath() {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return null
  }
  const linkDirectory =
    process.env.ORCA_KYLE_DEV_CLI_LINK_DIR ?? path.join(process.env.HOME ?? '', '.local', 'bin')
  if (!path.isAbsolute(linkDirectory)) {
    throw new Error('ORCA_KYLE_DEV_CLI_LINK_DIR must be an absolute path')
  }
  return path.join(linkDirectory, 'orca-kyle-dev')
}
