/**
 * i18n setup (react-i18next).
 *
 * Source/default locale is English — every key's English value IS the
 * canonical UI string (consistent with "code/UI source in English";
 * other locales are translation layers, never a fork of the source).
 *
 * Resources are bundled (the app ships a few small locales; no lazy
 * namespace loading needed) and split **one JSON file per namespace
 * per language** so independent areas can be translated in parallel
 * without touching a shared file. ALL namespaces are pre-registered
 * here, so adding strings to an area only edits that area's two JSON
 * files + its components — never this file.
 *
 * Language is detected from localStorage (`nf:lang`) then the browser,
 * and the chosen language is cached back to localStorage.
 */
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'

import enCommon from './locales/en/common.json'
import enToolbar from './locales/en/toolbar.json'
import enScreens from './locales/en/screens.json'
import enDialogs from './locales/en/dialogs.json'
import enInspector from './locales/en/inspector.json'
import enTimeline from './locales/en/timeline.json'
import enEditor from './locales/en/editor.json'

import jaCommon from './locales/ja/common.json'
import jaToolbar from './locales/ja/toolbar.json'
import jaScreens from './locales/ja/screens.json'
import jaDialogs from './locales/ja/dialogs.json'
import jaInspector from './locales/ja/inspector.json'
import jaTimeline from './locales/ja/timeline.json'
import jaEditor from './locales/ja/editor.json'

import ptCommon from './locales/pt-BR/common.json'
import ptToolbar from './locales/pt-BR/toolbar.json'
import ptScreens from './locales/pt-BR/screens.json'
import ptDialogs from './locales/pt-BR/dialogs.json'
import ptInspector from './locales/pt-BR/inspector.json'
import ptTimeline from './locales/pt-BR/timeline.json'
import ptEditor from './locales/pt-BR/editor.json'

export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  // Brazilian Portuguese; 'pt-BR' collapses to 'pt' (load: 'languageOnly').
  { code: 'pt', label: 'Português (Brasil)' },
] as const

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]['code']

export const I18N_NAMESPACES = [
  'common',
  'toolbar',
  'screens',
  'dialogs',
  'inspector',
  'timeline',
  'editor',
] as const

const resources = {
  en: {
    common: enCommon,
    toolbar: enToolbar,
    screens: enScreens,
    dialogs: enDialogs,
    inspector: enInspector,
    timeline: enTimeline,
    editor: enEditor,
  },
  ja: {
    common: jaCommon,
    toolbar: jaToolbar,
    screens: jaScreens,
    dialogs: jaDialogs,
    inspector: jaInspector,
    timeline: jaTimeline,
    editor: jaEditor,
  },
  pt: {
    common: ptCommon,
    toolbar: ptToolbar,
    screens: ptScreens,
    dialogs: ptDialogs,
    inspector: ptInspector,
    timeline: ptTimeline,
    editor: ptEditor,
  },
} as const

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'en',
    supportedLngs: ['en', 'ja', 'pt'],
    // 'ja-JP' / 'en-US' collapse to the base language.
    load: 'languageOnly',
    nonExplicitSupportedLngs: true,
    ns: I18N_NAMESPACES,
    defaultNS: 'common',
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'nf:lang',
      caches: ['localStorage'],
    },
    interpolation: {
      // React already escapes; double-escaping would mangle output.
      escapeValue: false,
    },
    react: {
      // Resources are bundled and synchronous, so there's nothing to
      // suspend on — keep it off to avoid needing a Suspense boundary.
      useSuspense: false,
    },
  })

export default i18n
