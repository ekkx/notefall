import type { ReactNode } from 'react'
import { SubmenuTrigger } from 'react-aria-components'
import { useTranslation } from 'react-i18next'
import i18n, { SUPPORTED_LANGUAGES, type LanguageCode } from '../i18n'
import { MenuItem, MenuPopover } from './kit'

/**
 * "Language" row of the app menu with the languages as a submenu. Each item shows the
 * language's OWN label (never translated); the active one is checked. Selecting calls
 * `i18n.changeLanguage`, which the detector persists to localStorage. Must be rendered
 * as a direct child of the app menu.
 */
export function LanguageSubmenu({ icon }: { icon?: ReactNode }) {
  const { t, i18n: i18nInstance } = useTranslation('toolbar')
  // Collapse 'ja-JP' → 'ja' so the active marker still matches.
  const active = i18nInstance.language?.split('-')[0]

  return (
    <SubmenuTrigger>
      <MenuItem icon={icon} textValue={t('app.language')}>
        {t('app.language')}
      </MenuItem>
      <MenuPopover aria-label={t('app.language')} placement="end top" menuClassName="min-w-[160px]">
        {SUPPORTED_LANGUAGES.map((lang) => (
          <MenuItem
            key={lang.code}
            checked={lang.code === active}
            textValue={lang.label}
            onAction={() => void i18n.changeLanguage(lang.code as LanguageCode)}
          >
            {lang.label}
          </MenuItem>
        ))}
      </MenuPopover>
    </SubmenuTrigger>
  )
}
