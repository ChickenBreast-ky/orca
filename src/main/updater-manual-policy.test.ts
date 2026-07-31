import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { OFFICIAL_UPDATER_ENDPOINTS } from '../shared/update-policy'

const { appMock, loadAutoUpdaterMock, netFetchMock, powerMonitorOnMock } = vi.hoisted(() => ({
  appMock: {
    getVersion: () => '1.4.160',
    isPackaged: true,
    on: vi.fn()
  },
  loadAutoUpdaterMock: vi.fn(() => {
    throw new Error('official updater must stay unloaded')
  }),
  netFetchMock: vi.fn(),
  powerMonitorOnMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: { getAllWindows: () => [] },
  net: { fetch: netFetchMock },
  powerMonitor: { on: powerMonitorOnMock }
}))

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('./electron-updater-loader', () => ({ loadElectronAutoUpdater: loadAutoUpdaterMock }))

describe('manual local update policy', () => {
  it('keeps startup, manual checks, downloads, release lists, and remote-server operations offline', async () => {
    vi.useFakeTimers()
    const {
      checkForRemoteServerUpdate,
      checkForUpdates,
      checkForUpdatesFromMenu,
      downloadRemoteServerUpdate,
      downloadUpdate,
      getRemoteServerUpdaterSnapshot,
      getUpdateStatus,
      listAvailableReleaseBuilds,
      setupAutoUpdater
    } = await import('./updater')

    const send = vi.fn()
    setupAutoUpdater({ webContents: { send } } as never, { getLastUpdateCheckAt: () => null })
    checkForUpdates()
    checkForUpdatesFromMenu({ channel: 'hourly', targetTag: 'malformed' })
    downloadUpdate()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)

    expect(getUpdateStatus()).toMatchObject({ state: 'manual', policy: 'manual-local-only' })
    expect(await listAvailableReleaseBuilds('stable')).toEqual([])
    expect(checkForRemoteServerUpdate('remote-1').support).toMatchObject({
      automatic: false,
      reason: 'manual-local-install-required'
    })
    expect(downloadRemoteServerUpdate('remote-1').status).toMatchObject({
      state: 'manual',
      policy: 'manual-local-only'
    })
    expect(getRemoteServerUpdaterSnapshot('remote-1').status).toMatchObject({
      state: 'manual',
      policy: 'manual-local-only'
    })
    expect(loadAutoUpdaterMock).not.toHaveBeenCalled()
    expect(netFetchMock).not.toHaveBeenCalled()
    expect(powerMonitorOnMock).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'manual', policy: 'manual-local-only' })
    )
    vi.useRealTimers()
  })

  it('keeps direct feed, build-list, and nudge helpers offline', async () => {
    const [
      { fetchChangelog },
      { fetchNudge },
      { listReleaseBuilds },
      { fetchNewerReleaseTagsWithReadiness }
    ] = await Promise.all([
      import('./updater-changelog'),
      import('./updater-nudge'),
      import('./updater-release-builds'),
      import('./updater-prerelease-feed')
    ])

    expect(await fetchChangelog('1.4.161', '1.4.160')).toEqual({
      kind: 'manual',
      policy: 'manual-local-only'
    })
    expect(await fetchNudge()).toBeNull()
    expect(await listReleaseBuilds('rc')).toEqual([])
    expect(await fetchNewerReleaseTagsWithReadiness('1.4.160', 1)).toEqual({
      tags: [],
      state: 'no-newer'
    })
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('keeps updater URL hosts inside the explicit endpoint ledger', async () => {
    const sourceFiles = [
      'src/main/updater.ts',
      'src/main/updater-changelog.ts',
      'src/main/updater-nudge.ts',
      'src/main/updater-prerelease-feed.ts',
      'src/main/updater-release-builds.ts'
    ]
    const source = await Promise.all(
      sourceFiles.map((file) => readFile(resolve(process.cwd(), file), 'utf8'))
    )
    const urls = source.flatMap((text) => text.match(/https:\/\/[^'"`\s)]+/g) ?? [])
    const hosts = new Set(urls.map((url) => new URL(url).host))
    const allowedHosts = new Set(OFFICIAL_UPDATER_ENDPOINTS.map((url) => new URL(url).host))

    expect([...hosts].every((host) => allowedHosts.has(host))).toBe(true)
  })
})
