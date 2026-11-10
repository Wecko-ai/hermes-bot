import { useSyncExternalStore } from 'react'
import type { ModelOption, ModelOverride } from '../types'
import { LANGUAGES, type LanguageChoice } from '../i18n'

export const THEMES = ['system', 'light', 'dark'] as const
export const TEXT_SIZES = ['small', 'normal', 'large'] as const
export const SEND_KEYS = ['enter', 'cmd-enter'] as const

export type ThemeChoice = (typeof THEMES)[number]
export type TextSize = (typeof TEXT_SIZES)[number]
export type SendKey = (typeof SEND_KEYS)[number]

export interface AppSettings {
  /** Interface language. `system` follows macOS: French if it is French, English otherwise. */
  language: LanguageChoice
  theme: ThemeChoice
  textSize: TextSize
  reduceMotion: boolean
  showUsage: boolean
  sendKey: SendKey
  /** Caveman mode: every bot answers in few words. A note read with each turn sent from the composer. */
  caveman: boolean
  activitySort: boolean
  showHidden: boolean
  /** Hide list, not an allow list: a newly released model is still offered. */
  hiddenModels: string[]
  /** Ollama model of the local chat. Empty: the configuration's, else the first installed. */
  localModel: string
}

const STORAGE_KEY = 'hermesbot-settings'

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback
}

/** Validates each field. The old keys only count while the setting has never been written. */
export function parseSettings(saved: string | null, legacy: (key: string) => string | null = () => null): AppSettings {
  let value: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(saved || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed as Record<string, unknown>
  } catch { /* unreadable settings: default values */ }
  const flag = (field: unknown, fallback: boolean) => typeof field === 'boolean' ? field : fallback
  return {
    language: oneOf(value.language, LANGUAGES, 'system'),
    theme: oneOf(value.theme, THEMES, oneOf(legacy('hermesbot-theme'), THEMES, 'system')),
    textSize: oneOf(value.textSize, TEXT_SIZES, 'normal'),
    reduceMotion: flag(value.reduceMotion, false),
    showUsage: flag(value.showUsage, legacy('hermesbot-show-usage') === '1'),
    sendKey: oneOf(value.sendKey, SEND_KEYS, 'enter'),
    caveman: flag(value.caveman, false),
    activitySort: flag(value.activitySort, legacy('hermesbot-sort') === 'activity'),
    showHidden: flag(value.showHidden, false),
    hiddenModels: Array.isArray(value.hiddenModels) ? value.hiddenModels.filter((key): key is string => typeof key === 'string') : [],
    localModel: typeof value.localModel === 'string' ? value.localModel : '',
  }
}

function load(): AppSettings {
  try {
    return parseSettings(localStorage.getItem(STORAGE_KEY), (key) => localStorage.getItem(key))
  } catch {
    return parseSettings(null)
  }
}

let current = load()
const listeners = new Set<() => void>()

export const getSettings = () => current

export function updateSettings(changes: Partial<AppSettings>) {
  current = { ...current, ...changes }
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(current)) } catch { /* storage unavailable */ }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const subscribeSettings = subscribe

export const useSettings = () => useSyncExternalStore(subscribe, getSettings)

/** The same model at two providers is set separately. */
export const hiddenModelKey = (option: ModelOverride) => `${option.provider}:${option.model}`

/** The active model and the profile's stay offered: the picker must always be able to show them. */
export function selectableModels(options: ModelOption[], hidden: string[], keep: string[]) {
  const masked = new Set(hidden)
  return options.filter((option) => !masked.has(hiddenModelKey(option)) || keep.includes(option.model))
}

export function withModelsVisible(hidden: string[], options: ModelOverride[], visible: boolean) {
  const keys = new Set(options.map(hiddenModelKey))
  const others = hidden.filter((key) => !keys.has(key))
  return visible ? others : [...others, ...keys]
}
