import { beforeEach, describe, expect, it, vi } from 'vitest'

const { netFetchMock } = vi.hoisted(() => ({
  netFetchMock: vi.fn()
}))

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))

describe('fetchNewerReleaseTagsWithReadiness', () => {
  beforeEach(() => {
    netFetchMock.mockReset()
  })

  it('returns the manual-local policy result without loading the release transport', async () => {
    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')

    await expect(fetchNewerReleaseTagsWithReadiness('1.4.26', 1)).resolves.toEqual({
      tags: [],
      state: 'no-newer'
    })
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('keeps prerelease and bounded inputs offline', async () => {
    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')

    await expect(
      fetchNewerReleaseTagsWithReadiness('1.4.26-rc.1', 1, { includePrerelease: true })
    ).resolves.toEqual({ tags: [], state: 'no-newer' })
    await expect(fetchNewerReleaseTagsWithReadiness('1.4.26', 0)).resolves.toEqual({
      tags: [],
      state: 'no-newer'
    })
    expect(netFetchMock).not.toHaveBeenCalled()
  })
})
