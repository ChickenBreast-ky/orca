import type React from 'react'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'

export function GeneralRemoteServerUpdates(): React.JSX.Element {
  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.GeneralRemoteServerUpdates.title',
        'Remote Orca Servers'
      )}
      description={translate(
        'auto.components.settings.GeneralRemoteServerUpdates.description',
        'Paired servers are updated manually through their own trusted local installation path.'
      )}
      keywords={['remote server', 'manual install', 'version']}
      data-update-policy="manual-local-only"
    >
      <p className="text-xs text-muted-foreground" data-update-policy="manual-local-only">
        {translate(
          'auto.components.settings.GeneralRemoteServerUpdates.manualOnly',
          'Remote server updates are manual-only. This client does not check, download, or install server updates.'
        )}
      </p>
    </SearchableSetting>
  )
}
