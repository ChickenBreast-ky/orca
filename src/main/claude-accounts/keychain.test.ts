import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deleteActiveClaudeKeychainCredentials,
  deleteManagedClaudeKeychainCredentials,
  readActiveClaudeKeychainCredentials,
  readActiveClaudeKeychainCredentialsStrict,
  readManagedClaudeKeychainCredentials,
  writeActiveClaudeKeychainCredentials,
  writeActiveClaudeKeychainCredentialsForRuntime,
  writeManagedClaudeKeychainCredentials
} from './keychain'

vi.mock('node:child_process', () => ({
  execFile: vi.fn()
}))

const execFileMock = vi.mocked(execFile)
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
}

function serviceForConfigDir(configDir: string): string {
  const suffix = createHash('sha256').update(configDir).digest('hex').slice(0, 8)
  return `Orca Kyle Claude Code Credentials-${suffix}`
}

function invokeExecFileCallback(
  callback: unknown,
  error: Error | null,
  stdout: string,
  stderr: string
): void {
  const execCallback = callback as (error: Error | null, stdout: string, stderr: string) => void
  execCallback(error, stdout, stderr)
}

describe('Claude Keychain credentials', () => {
  beforeEach(() => {
    setPlatform('darwin')
    execFileMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('reads only fork-scoped Claude credentials without importing shared credentials', async () => {
    const configDir = '/tmp/orca-claude-login-test'
    const scopedService = serviceForConfigDir(configDir)
    execFileMock.mockImplementationOnce((_file, _args, _options, callback) => {
      invokeExecFileCallback(callback, null, '{"claudeAiOauth":{"accessToken":"scoped"}}\n', '')
      return null as never
    })

    await expect(readActiveClaudeKeychainCredentials(configDir)).resolves.toBe(
      '{"claudeAiOauth":{"accessToken":"scoped"}}'
    )

    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(execFileMock.mock.calls[0][1]).toEqual([
      'find-generic-password',
      '-s',
      scopedService,
      '-a',
      process.env.USER || process.env.USERNAME || 'user',
      '-w'
    ])
  })

  it('does not fall back to the shared Claude Code credentials service', async () => {
    const configDir = '/tmp/orca-kyle-claude-login-test'
    const notFound = Object.assign(new Error('not found'), { code: 44 })
    execFileMock.mockImplementationOnce((_file, _args, _options, callback) => {
      invokeExecFileCallback(callback, notFound, '', 'could not be found')
      return null as never
    })

    await expect(readActiveClaudeKeychainCredentials(configDir)).resolves.toBeNull()
    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(executedServices()).not.toContain('Claude Code-credentials')
  })

  it('writes active credentials to the config-scoped Claude Code service', async () => {
    const configDir = '/tmp/orca-claude-login-test'
    const scopedService = serviceForConfigDir(configDir)
    execFileMock.mockImplementationOnce((_file, _args, _options, callback) => {
      invokeExecFileCallback(callback, null, '', '')
      return null as never
    })

    await writeActiveClaudeKeychainCredentials('credentials-json', configDir)

    expect(execFileMock.mock.calls[0][1]).toEqual([
      'add-generic-password',
      '-U',
      '-s',
      scopedService,
      '-a',
      process.env.USER || process.env.USERNAME || 'user',
      '-w',
      'credentials-json'
    ])
  })

  it('writes runtime credentials only to the fork-scoped service', async () => {
    const configDir = '/tmp/orca-claude-login-test'
    const scopedService = serviceForConfigDir(configDir)
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      invokeExecFileCallback(callback, null, '', '')
      return null as never
    })

    await writeActiveClaudeKeychainCredentialsForRuntime('credentials-json', configDir)

    expect(execFileMock.mock.calls.map((call) => call[1])).toEqual([
      [
        'add-generic-password',
        '-U',
        '-s',
        scopedService,
        '-a',
        process.env.USER || process.env.USERNAME || 'user',
        '-w',
        'credentials-json'
      ]
    ])
  })

  it('strictly reads only the requested active credentials service', async () => {
    const configDir = '/tmp/orca-claude-login-test'
    const scopedService = serviceForConfigDir(configDir)
    execFileMock.mockImplementationOnce((_file, _args, _options, callback) => {
      invokeExecFileCallback(callback, null, 'scoped\n', '')
      return null as never
    })

    await expect(readActiveClaudeKeychainCredentialsStrict(configDir)).resolves.toBe('scoped')

    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(execFileMock.mock.calls[0][1]).toEqual([
      'find-generic-password',
      '-s',
      scopedService,
      '-a',
      process.env.USER || process.env.USERNAME || 'user',
      '-w'
    ])
  })

  it('rejects when a keychain read never reports completion', async () => {
    vi.useFakeTimers()
    const configDir = '/tmp/orca-claude-login-test'
    const killMock = vi.fn()
    execFileMock.mockImplementationOnce(() => ({ kill: killMock }) as never)

    let settled = false
    let rejected: unknown
    const readPromise = readActiveClaudeKeychainCredentialsStrict(configDir).then(
      (credentials) => {
        settled = true
        return credentials
      },
      (error: unknown) => {
        settled = true
        rejected = error
        return null
      }
    )

    await vi.advanceTimersByTimeAsync(3000)

    expect(settled).toBe(true)
    await readPromise
    expect(rejected).toEqual(
      expect.objectContaining({ message: 'security timed out after 3000ms' })
    )
    expect(killMock).toHaveBeenCalled()
  })

  it('deletes only fork-scoped active credentials during config-dir cleanup', async () => {
    const configDir = '/tmp/orca-claude-login-test'
    const scopedService = serviceForConfigDir(configDir)
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      invokeExecFileCallback(callback, null, '', '')
      return null as never
    })

    await deleteActiveClaudeKeychainCredentials(configDir)

    expect(execFileMock.mock.calls.map((call) => call[1])).toEqual([
      [
        'delete-generic-password',
        '-s',
        scopedService,
        '-a',
        process.env.USER || process.env.USERNAME || 'user'
      ]
    ])
  })

  it('routes every app-managed credential mutation to a fork-only service', async () => {
    const configDir = '/tmp/orca-kyle-claude-login-test'
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      invokeExecFileCallback(callback, null, '', '')
      return null as never
    })

    await writeActiveClaudeKeychainCredentials('credentials-json', configDir)
    await writeActiveClaudeKeychainCredentialsForRuntime('credentials-json', configDir)
    await deleteActiveClaudeKeychainCredentials(configDir)
    await writeManagedClaudeKeychainCredentials('account-id', 'credentials-json')
    await deleteManagedClaudeKeychainCredentials('account-id')

    const services = executedServices()
    expect(services).toHaveLength(5)
    expect(services.every((service) => service.startsWith('Orca Kyle '))).toBe(true)
    expect(services).not.toContain('Claude Code-credentials')
    expect(services).not.toContain('Orca Claude Code Managed Credentials')
  })

  it('reads managed credentials from the fork-only service', async () => {
    execFileMock.mockImplementationOnce((_file, _args, _options, callback) => {
      invokeExecFileCallback(callback, null, 'credentials-json\n', '')
      return null as never
    })

    await expect(readManagedClaudeKeychainCredentials('account-id')).resolves.toBe(
      'credentials-json'
    )
    expect(executedServices()).toEqual(['Orca Kyle Claude Code Managed Credentials'])
  })
})

function executedServices(): string[] {
  return execFileMock.mock.calls.flatMap((call) => {
    const args = call[1]
    if (!Array.isArray(args)) {
      return []
    }
    const serviceIndex = args.indexOf('-s')
    const service = args[serviceIndex + 1]
    return typeof service === 'string' ? [service] : []
  })
}
