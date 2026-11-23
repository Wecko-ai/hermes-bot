import { useSyncExternalStore } from 'react'
import type { ModelOption, ModelOverride } from '../types'
import { LANGUAGES, type LanguageChoice } from '../i18n'
import { modelCost } from './free-models'

export const THEMES = ['system', 'light', 'dark'] as const
export const TEXT_SIZES = ['small', 'normal', 'large'] as const
export const SEND_KEYS = ['enter', 'cmd-enter'] as const
/** Language the dictation listens for. `interface`: the interface language. */
export const DICTATION_LANGUAGES = ['interface', 'fr', 'en'] as const

export type ThemeChoice = (typeof THEMES)[number]
export type TextSize = (typeof TEXT_SIZES)[number]
export type SendKey = (typeof SEND_KEYS)[number]
export type DictationLanguage = (typeof DICTATION_LANGUAGES)[number]

export interface AppSettings {
  /** Interface language. `system` follows macOS: French if it is French, English otherwise. */
  language: LanguageChoice
  theme: ThemeChoice
  textSize: TextSize
  reduceMotion: boolean
  showUsage: boolean
  sendKey: SendKey
  /** Language macOS listens for when dictating. Lets French be dictated under an English interface. */
  dictationLanguage: DictationLanguage
  /** Caveman mode: every bot answers in few words. A note read with each turn sent from the composer. */
  caveman: boolean
  /** Background-task style: acknowledge, brief progress, then the result (`api_text` only). */
  backgroundTask: boolean
  /** Warm, concise tone charter on each turn (`api_text` only). */
  toneCharter: boolean
  /** Show `message.interim` milestones as bubbles grouped with the final reply. */
  progressInThread: boolean
  activitySort: boolean
  showHidden: boolean
  /** Bots pinned at the top of the sidebar, in the order they were pinned. Kept on this Mac only. */
  pinnedBots: string[]
  /** Hide list, not an allow list: a newly released model is still offered. */
  hiddenModels: string[]
  /** Zero-spend mode: free and subscription models only. Local mirror of shared `zeroSpend`; also its legacy fallback. */
  freeMode: boolean
  /** Ollama model of the local chat. Empty: the configuration's, else the first installed. */
  localModel: string
  /** macOS notification when a bot finishes a turn or waits on an answer, unless its chat is in view. */
  notifications: boolean
  /** Voice mode: the voice of each language (identifier of a Mac voice). Empty: the system voice. */
  voiceFr: string
  voiceEn: string
  /** Voice mode: speaking rate, 0.5 to 2 times the normal rate. */
  voiceRate: number
  /** Voice mode: also speak the short steps a bot writes before its tools. */
  voiceSteps: boolean
  /** Voice mode: hands-free (the microphone reopens after each reply) rather than push-to-talk. */
  voiceHandsFree: boolean
  /** Context compaction (Settings > Conversations). Mirrors the gateway's shared copy, which wins. */
  compactionMode: 'auto' | 'manual'
  /** Manual mode: the user's limit, a share of the model's context window (0.1 to 1). */
  compactionGauge: number
  /** When auto routing is enabled server-side, new sends pick a model automatically. */
  useAutoModel: boolean
  useAutoFreeModel: boolean
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
  const strings = (field: unknown) => Array.isArray(field) ? field.filter((key): key is string => typeof key === 'string') : []
  return {
    language: oneOf(value.language, LANGUAGES, 'system'),
    theme: oneOf(value.theme, THEMES, oneOf(legacy('hermesbot-theme'), THEMES, 'system')),
    textSize: oneOf(value.textSize, TEXT_SIZES, 'normal'),
    reduceMotion: flag(value.reduceMotion, false),
    showUsage: flag(value.showUsage, legacy('hermesbot-show-usage') === '1'),
    sendKey: oneOf(value.sendKey, SEND_KEYS, 'enter'),
    dictationLanguage: oneOf(value.dictationLanguage, DICTATION_LANGUAGES, 'interface'),
    caveman: flag(value.caveman, false),
    backgroundTask: flag(value.backgroundTask, true),
    toneCharter: flag(value.toneCharter, false),
    progressInThread: flag(value.progressInThread, true),
    activitySort: flag(value.activitySort, legacy('hermesbot-sort') === 'activity'),
    showHidden: flag(value.showHidden, false),
    pinnedBots: strings(value.pinnedBots),
    hiddenModels: strings(value.hiddenModels),
    freeMode: flag(value.freeMode, false),
    localModel: typeof value.localModel === 'string' ? value.localModel : '',
    notifications: flag(value.notifications, true),
    voiceFr: typeof value.voiceFr === 'string' ? value.voiceFr.slice(0, 200) : '',
    voiceEn: typeof value.voiceEn === 'string' ? value.voiceEn.slice(0, 200) : '',
    voiceRate: typeof value.voiceRate === 'number' && Number.isFinite(value.voiceRate) ? Math.min(2, Math.max(0.5, value.voiceRate)) : 1,
    voiceSteps: flag(value.voiceSteps, true),
    voiceHandsFree: flag(value.voiceHandsFree, true),
    compactionMode: value.compactionMode === 'manual' ? 'manual' : 'auto',
    compactionGauge: typeof value.compactionGauge === 'number' && Number.isFinite(value.compactionGauge) ? Math.round(Math.min(1, Math.max(0.1, value.compactionGauge)) * 100) / 100 : 1,
    // Absent key: Auto is the default. An explicit false is kept (see load() for the 0.2.9 migration).
    useAutoModel: flag(value.useAutoModel, true),
    useAutoFreeModel: flag(value.useAutoFreeModel, false),
  }
}

const AUTO_DEFAULT_APPLIED = 'autoDefaultApplied'

function persist(settings: AppSettings, extra: Record<string, unknown> = {}) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...settings, ...extra })) } catch { /* storage unavailable */ }
}

/** Older full saves wrote useAutoModel: false even when the user never turned Auto off. Run once. */
export function withAutoDefaultMigration(settings: AppSettings, saved: string | null): AppSettings {
  let raw: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(saved || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>
  } catch { /* unreadable: treat as empty */ }
  if (raw[AUTO_DEFAULT_APPLIED] === true) return settings
  if (settings.useAutoFreeModel) return settings
  return { ...settings, useAutoModel: true }
}

function load(): AppSettings {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    const settings = withAutoDefaultMigration(parseSettings(saved, (key) => localStorage.getItem(key)), saved)
    let rawApplied = false
    try {
      const parsed: unknown = JSON.parse(saved || '{}')
      rawApplied = Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed as Record<string, unknown>)[AUTO_DEFAULT_APPLIED] === true)
    } catch { /* ignore */ }
    if (!rawApplied) persist(settings, { [AUTO_DEFAULT_APPLIED]: true })
    return settings
  } catch {
    return parseSettings(null)
  }
}

let current = load()
const listeners = new Set<() => void>()

export const getSettings = () => current

export function updateSettings(changes: Partial<AppSettings>) {
  current = { ...current, ...changes }
  persist(current, { [AUTO_DEFAULT_APPLIED]: true })
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const subscribeSettings = subscribe

export const useSettings = () => useSyncExternalStore(subscribe, getSettings)

/** The language the dictation listens for: the chosen one, else the interface's. */
export function dictationLanguageCode(choice: DictationLanguage, interfaceLanguage: string): 'en' | 'fr' {
  if (choice !== 'interface') return choice
  return interfaceLanguage === 'fr' ? 'fr' : 'en'
}

/** Pins or unpins a bot. A new pin goes after the others: the pinned group keeps its order. */
export function withPinned(pinned: readonly string[], slug: string, pin: boolean): string[] {
  const others = pinned.filter((item) => item !== slug)
  return pin ? [...others, slug] : others
}

/** The same model at two providers is set separately. */
export const hiddenModelKey = (option: ModelOverride) => `${option.provider}:${option.model}`

/**
 * The active model and the profile's stay offered: the picker must always be able to show them.
 * In free mode (`subscriptions` given), the paid models go too, the kept ones excepted: what stays
 * is free or comes with a subscription already paid.
 */
export function selectableModels(options: ModelOption[], hidden: string[], keep: string[], subscriptions?: readonly string[]) {
  const masked = new Set(hidden)
  return options.filter((option) => keep.includes(option.model)
    || (!masked.has(hiddenModelKey(option)) && (!subscriptions || modelCost(option, subscriptions) !== 'paid')))
}

export function withModelsVisible(hidden: string[], options: ModelOverride[], visible: boolean) {
  const keys = new Set(options.map(hiddenModelKey))
  const others = hidden.filter((key) => !keys.has(key))
  return visible ? others : [...others, ...keys]
}
