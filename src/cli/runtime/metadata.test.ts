import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { getDefaultUserDataPath } from './metadata'

const originalDevInvocation = process.env.ORCA_DEV_CLI_INVOCATION
const originalQaFlag = process.env.ORCA_KYLE_QA
const originalQaPath = process.env.ORCA_KYLE_QA_USER_DATA_PATH
const originalUserDataPath = process.env.ORCA_USER_DATA_PATH

afterEach(() => {
  restoreEnv('ORCA_DEV_CLI_INVOCATION', originalDevInvocation)
  restoreEnv('ORCA_KYLE_QA', originalQaFlag)
  restoreEnv('ORCA_KYLE_QA_USER_DATA_PATH', originalQaPath)
  restoreEnv('ORCA_USER_DATA_PATH', originalUserDataPath)
})

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

describe('getDefaultUserDataPath', () => {
  it('matches the packaged Orca Kyle GUI userData contract on macOS', () => {
    const homeDir = '/Users/fork-test'
    const expectedPath = join(homeDir, 'Library', 'Application Support', 'Orca Kyle')
    delete process.env.ORCA_DEV_CLI_INVOCATION
    delete process.env.ORCA_KYLE_QA
    delete process.env.ORCA_KYLE_QA_USER_DATA_PATH
    process.env.ORCA_USER_DATA_PATH = expectedPath

    expect(getDefaultUserDataPath('darwin', homeDir)).toBe(expectedPath)
  })

  it('rejects an inherited official Orca userData path', () => {
    const homeDir = '/Users/fork-test'
    delete process.env.ORCA_DEV_CLI_INVOCATION
    delete process.env.ORCA_KYLE_QA
    delete process.env.ORCA_KYLE_QA_USER_DATA_PATH
    process.env.ORCA_USER_DATA_PATH = join(homeDir, 'Library', 'Application Support', 'Orca')

    expect(() => getDefaultUserDataPath('darwin', homeDir)).toThrow(
      'inherited userData path does not match the Orca Kyle contract'
    )
  })
})
