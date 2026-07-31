import type React from 'react'
import { translate } from '@/i18n/i18n'
import { GeneralRemoteServerUpdates } from './GeneralRemoteServerUpdates'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSubsectionHeader } from './SettingsFormControls'

export function GeneralUpdateSettingsSection(): React.JSX.Element {
  return (
    <section key="updates" className="space-y-4" data-update-policy="manual-local-only">
      <SettingsSubsectionHeader
        title={translate(
          'auto.components.settings.GeneralUpdateSettingsSection.f2b1ccc12a',
          'Updates'
        )}
        description={translate(
          'auto.components.settings.GeneralUpdateSettingsSection.d91ebfb87e',
          'Install app updates manually from a trusted local package. Orca does not check for or download updates.'
        )}
      />
      <SearchableSetting
        title={translate(
          'auto.components.settings.GeneralUpdateSettingsSection.e1a647adc5',
          'Manual app updates'
        )}
        description={translate(
          'auto.components.settings.GeneralUpdateSettingsSection.ceb579abaf',
          'App updates are manual-only in this build.'
        )}
        keywords={['update', 'version', 'manual install']}
      >
        <p className="text-xs text-muted-foreground" data-update-policy="manual-local-only">
          {translate(
            'auto.components.settings.GeneralUpdateSettingsSection.d69a09b672',
            'Download and install a trusted local package yourself. Orca does not report whether you are on the latest version.'
          )}
        </p>
      </SearchableSetting>
      <GeneralRemoteServerUpdates />
    </section>
  )
}
