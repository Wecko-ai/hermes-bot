import { useSyncExternalStore } from 'react'
import type { ModelOption, ModelOverride } from '../types'

export const THEMES = ['system', 'light', 'dark'] as const
export const TEXT_SIZES = ['small', 'normal', 'large'] as const
export const SEND_KEYS = ['enter', 'cmd-enter'] as const

export type ThemeChoice = (typeof THEMES)[number]
export type TextSize = (typeof TEXT_SIZES)[number]
export type SendKey = (typeof SEND_KEYS)[number]

export interface AppSettings {
  theme: ThemeChoice
  textSize: TextSize
  reduceMotion: boolean
  showUsage: boolean
  sendKey: SendKey
  activitySort: boolean
  showHidden: boolean
  /** Liste de masquage, pas d’autorisation : un modèle qui vient de sortir reste proposé. */
  hiddenModels: string[]
  /** Modèle Ollama du chat local. Vide : celui de la configuration, sinon le premier installé. */
  localModel: string
}

const STORAGE_KEY = 'hermesbot-settings'

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback
}

/** Valide chaque champ. Les anciennes clés ne servent que tant que le réglage n’a jamais été écrit. */
export function parseSettings(saved: string | null, legacy: (key: string) => string | null = () => null): AppSettings {
  let value: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(saved || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed as Record<string, unknown>
  } catch { /* réglages illisibles : valeurs par défaut */ }
  const flag = (field: unknown, fallback: boolean) => typeof field === 'boolean' ? field : fallback
  return {
    theme: oneOf(value.theme, THEMES, oneOf(legacy('hermesbot-theme'), THEMES, 'system')),
    textSize: oneOf(value.textSize, TEXT_SIZES, 'normal'),
    reduceMotion: flag(value.reduceMotion, false),
    showUsage: flag(value.showUsage, legacy('hermesbot-show-usage') === '1'),
    sendKey: oneOf(value.sendKey, SEND_KEYS, 'enter'),
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
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(current)) } catch { /* storage indisponible */ }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const useSettings = () => useSyncExternalStore(subscribe, getSettings)

/** Le même modèle chez deux fournisseurs se règle séparément. */
export const hiddenModelKey = (option: ModelOverride) => `${option.provider}:${option.model}`

/** Le modèle actif et celui du profil restent proposés : le sélecteur doit toujours pouvoir les montrer. */
export function selectableModels(options: ModelOption[], hidden: string[], keep: string[]) {
  const masked = new Set(hidden)
  return options.filter((option) => !masked.has(hiddenModelKey(option)) || keep.includes(option.model))
}

export function withModelsVisible(hidden: string[], options: ModelOverride[], visible: boolean) {
  const keys = new Set(options.map(hiddenModelKey))
  const others = hidden.filter((key) => !keys.has(key))
  return visible ? others : [...others, ...keys]
}
