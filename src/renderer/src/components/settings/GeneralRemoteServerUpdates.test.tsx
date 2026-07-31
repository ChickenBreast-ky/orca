// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GeneralRemoteServerUpdates } from './GeneralRemoteServerUpdates'

const storeMock = vi.hoisted(() => ({
  state: {
    settingsSearchQuery: '',
    remoteServerUpdates: new Map([
      [
        'server-a',
        {
          environmentId: 'server-a',
          name: 'Test server A',
          phase: 'current'
        }
      ]
    ]),
    remoteServerUpdatesChecking: false,
    remoteServerUpdatesRunning: false,
    refreshRemoteServerUpdates: vi.fn(),
    setRemoteServerUpdateDialogOpen: vi.fn()
  }
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof storeMock.state) => unknown) => selector(storeMock.state)
}))

describe('GeneralRemoteServerUpdates', () => {
  beforeEach(() => {
    storeMock.state.refreshRemoteServerUpdates.mockReset()
    storeMock.state.setRemoteServerUpdateDialogOpen.mockReset()
  })

  it('exposes the manual-local-only route without starting a remote check', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<GeneralRemoteServerUpdates />))

    expect(container.querySelector('[data-update-policy="manual-local-only"]')).not.toBeNull()
    expect(container.querySelector('button')).toBeNull()
    expect(storeMock.state.refreshRemoteServerUpdates).not.toHaveBeenCalled()
    expect(storeMock.state.setRemoteServerUpdateDialogOpen).not.toHaveBeenCalled()
    await act(async () => root.unmount())
  })
})
