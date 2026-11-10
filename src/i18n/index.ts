import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'

// One catalog file per area of the app and per language: locales/<language>/<area>.json.
// Each file holds its own top-level keys (`sidebar`, `composer`…); English is the reference.
type Catalog = Record<string, unknown>
const files = import.meta.glob<Catalog>('./locales/*/*.json', { eager: true, import: 'default' })

export function buildResources(entries: Record<string, Catalog>) {
  const resources: Record<string, { translation: Catalog }> = {}
  for (const [file, catalog] of Object.entries(entries)) {
    const language = /\/locales\/([a-z]{2})\//.exec(file)?.[1]
    if (!language) continue
    resources[language] ??= { translation: {} }
    for (const [key, value] of Object.entries(catalog)) {
      if (key in resources[language].translation) throw new Error(`i18n: key ${key} defined twice for ${language}`)
      resources[language].translation[key] = value
    }
  }
  return resources
}

export const resources = buildResources(files)

/** Interface languages. English is the reference catalog: every key exists there first. */
export const LANGUAGES = ['system', 'en', 'fr'] as const
export type LanguageChoice = (typeof LANGUAGES)[number]
export type Language = Exclude<LanguageChoice, 'system'>

/** `system` follows the browser (macOS) language: French if it is French, English otherwise. */
export function resolveLanguage(choice: LanguageChoice, systemLanguages: readonly string[] = typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language]): Language {
  if (choice !== 'system') return choice
  return systemLanguages.some((language) => language?.toLowerCase().startsWith('fr')) ? 'fr' : 'en'
}

export const i18n = i18next.createInstance()

void i18n.use(initReactI18next).init({
  resources,
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  returnNull: false,
  initAsync: false,
})

export function applyLanguage(choice: LanguageChoice) {
  const language = resolveLanguage(choice)
  if (i18n.language !== language) void i18n.changeLanguage(language)
  if (typeof document !== 'undefined') document.documentElement.lang = language
  return language
}

/** Locale for dates and numbers, following the interface language. */
export const locale = () => (i18n.language === 'fr' ? 'fr-FR' : 'en-US')
