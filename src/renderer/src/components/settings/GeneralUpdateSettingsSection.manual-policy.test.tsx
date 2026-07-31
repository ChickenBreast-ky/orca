// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { GeneralUpdateSettingsSection } from './GeneralUpdateSettingsSection'

describe('GeneralUpdateSettingsSection', () => {
  it('routes app and remote updates through the manual-local-only surface', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => root.render(<GeneralUpdateSettingsSection />))

    expect(container.querySelectorAll('[data-update-policy="manual-local-only"]')).toHaveLength(3)
    expect(container.querySelector('button')).toBeNull()
    await act(async () => root.unmount())
  })
})
