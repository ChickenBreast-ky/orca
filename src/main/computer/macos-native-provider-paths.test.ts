import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const existsSyncMock = vi.hoisted(() => vi.fn())

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock
}))

import {
  resolveMacOSComputerUseAppPath,
  resolveMacOSComputerUseExecutablePath
} from './macos-native-provider-paths'

const originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
const resourceRoot = '/tmp/orca-kyle-computer-use-fixture/resources'
const forkHelperAppPath = join(resourceRoot, 'Orca Kyle Computer Use.app')
const officialHelperAppPath = join(resourceRoot, 'Orca Computer Use.app')
const forkHelperExecutablePath = join(
  forkHelperAppPath,
  'Contents',
  'MacOS',
  'orca-computer-use-macos'
)

describe('macOS computer-use helper paths', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: resourceRoot
    })
    delete process.env.ORCA_COMPUTER_MACOS_HELPER_APP_PATH
    existsSyncMock.mockReset()
  })

  afterEach(() => {
    if (originalResourcesPath) {
      Object.defineProperty(process, 'resourcesPath', originalResourcesPath)
    } else {
      Reflect.deleteProperty(process, 'resourcesPath')
    }
  })

  it('resolves the packaged fork helper without falling back to the official helper name', () => {
    existsSyncMock.mockImplementation(
      (candidate) => candidate === forkHelperAppPath || candidate === officialHelperAppPath
    )

    expect(resolveMacOSComputerUseAppPath()).toBe(forkHelperAppPath)
    expect(existsSyncMock).not.toHaveBeenCalledWith(officialHelperAppPath)
  })

  it('resolves the executable inside the packaged fork helper bundle', () => {
    existsSyncMock.mockImplementation(
      (candidate) => candidate === forkHelperAppPath || candidate === forkHelperExecutablePath
    )

    expect(resolveMacOSComputerUseExecutablePath()).toBe(forkHelperExecutablePath)
  })
})
