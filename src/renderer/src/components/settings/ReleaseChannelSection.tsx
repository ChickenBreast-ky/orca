import type React from 'react'
import { translate } from '@/i18n/i18n'
import { SettingsSubsectionHeader } from './SettingsFormControls'

export function ReleaseChannelSection(): React.JSX.Element {
  return (
    <section className="space-y-4" data-update-policy="manual-local-only">
      <SettingsSubsectionHeader
        title={translate('auto.components.settings.ReleaseChannelSection.title', 'Release channel')}
        description={translate(
          'auto.components.settings.ReleaseChannelSection.description',
          'Release channel selection is unavailable while app updates are manual-only.'
        )}
      />
    </section>
  )
}
