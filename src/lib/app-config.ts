import { useSyncExternalStore } from 'react'

/** Settings of this installation, served by the local server (`/api/app-config`, from server/config.cjs). */
export interface AppConfig {
  ui: {
    /** Bot opened at start when it exists. */
    defaultBot: string
    /** Section order of the roster. Unlisted sections follow, alphabetically. */
    sectionOrder: string[]
    userInitial: string
    userName: string
    /** Providers never offered in the model picker. */
    hiddenProviders: string[]
    /** Bots drawn in the contrast color (black in light theme) when their profile sets no color. */
    contrastAvatars: string[]
  }
  /** Bots with `<slug>-working.webp` and `<slug>-done.webp` animations. */
  animatedBots: string[]
  localChat: { name: string }
}

export const DEFAULT_APP_CONFIG: AppConfig = {
  ui: { defaultBot: '', sectionOrder: [], userInitial: '', userName: '', hiddenProviders: [], contrastAvatars: [] },
  animatedBots: [],
  localChat: { name: '' },
}

let current = DEFAULT_APP_CONFIG
const listeners = new Set<() => void>()

const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '') : []
const text = (value: unknown) => typeof value === 'string' ? value : ''

export function parseAppConfig(value: unknown): AppConfig {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const ui = raw.ui && typeof raw.ui === 'object' ? raw.ui as Record<string, unknown> : {}
  const localChat = raw.localChat && typeof raw.localChat === 'object' ? raw.localChat as Record<string, unknown> : {}
  return {
    ui: {
      defaultBot: text(ui.defaultBot),
      sectionOrder: strings(ui.sectionOrder),
      userInitial: text(ui.userInitial).slice(0, 2),
      userName: text(ui.userName),
      hiddenProviders: strings(ui.hiddenProviders),
      contrastAvatars: strings(ui.contrastAvatars),
    },
    animatedBots: strings(raw.animatedBots),
    localChat: { name: text(localChat.name) },
  }
}

export function getAppConfig() {
  return current
}

export function setAppConfig(next: AppConfig) {
  current = next
  listeners.forEach((listener) => listener())
}

let loading: Promise<AppConfig> | null = null

/** Read once per window, before the roster. Without a server (demo, tests), the defaults stay. */
export function ensureAppConfig() {
  loading ??= loadAppConfig()
  return loading
}

export async function loadAppConfig() {
  try {
    const response = await fetch('/api/app-config', { credentials: 'same-origin' })
    if (response.ok) setAppConfig(parseAppConfig(await response.json()))
  } catch {
    // Defaults are enough to run.
  }
  return current
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useAppConfig() {
  return useSyncExternalStore(subscribe, getAppConfig, getAppConfig)
}

/**
 * Roster sections: the configured order first, then the others alphabetically, then `trailing` in its own order
 * (« Non classés », then the local chat), unless the configured order places them.
 */
export function compareSections(order: string[], trailing: string[]) {
  return (a: string, b: string) => {
    const rank = (section: string) => {
      if (order.includes(section)) return order.indexOf(section)
      const tail = trailing.indexOf(section)
      return tail >= 0 ? order.length + 1 + tail : order.length
    }
    return rank(a) - rank(b) || a.localeCompare(b, 'fr')
  }
}
