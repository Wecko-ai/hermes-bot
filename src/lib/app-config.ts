import { useSyncExternalStore } from 'react'

export interface UsageQuotaConfig {
  id: string
  label: string
  windowHours: number
  tokenLimit: number
  modelPrefixes: string[]
}

/** Settings of this installation, served by the local server (`/api/app-config`, from server/config.cjs). */
export interface AppConfig {
  channels: {
    wizardWrites: boolean
  }
  ui: {
    /** Bot opened at start when it exists. */
    defaultBot: string
    /** Section order of the roster. Unlisted sections follow, alphabetically. */
    sectionOrder: string[]
    rosterOrder: Record<string, string[]>
    userInitial: string
    userName: string
    /** Providers never offered in the model picker. */
    hiddenProviders: string[]
    /** Providers paid by a flat subscription: zero-spend mode keeps their models (they cost nothing more). */
    subscriptionProviders: string[]
    /** Initial zero-spend choice when neither the shared file nor the old local setting has one. */
    zeroSpendDefault: boolean
    /** Bots drawn in the contrast color (black in light theme) when their profile sets no color. */
    contrastAvatars: string[]
    /** Name shown for the voice mode; empty: the interface's own name for it. */
    voiceModeName: string
    /** Listen button on assistant replies (Electron speech). Default off. */
    replyListenButton: boolean
  }
  sharedMemory?: { injectContext: boolean; types: string[] }
  features: {
    usageGlobal: boolean
    vaultWallet: boolean
    pagesLibrary: boolean
  }
  usageQuotas: UsageQuotaConfig[]
  autoRouter?: { enabled: boolean; tableConfigured?: boolean; tablePath?: string }
  /** Bots with `<slug>-working.webp` and `<slug>-done.webp` animations. */
  animatedBots: string[]
  localChat: { name: string }
  routines: { editable: boolean; eventTriggers: boolean }
  connectors: { enabled: boolean }
  computerPanel: { enabled: boolean }
}

export const DEFAULT_APP_CONFIG: AppConfig = {
  sharedMemory: { injectContext: false, types: ['profile', 'rules', 'people', 'workstreams'] },
  features: { usageGlobal: true, vaultWallet: false, pagesLibrary: false },
  usageQuotas: [],
  autoRouter: { enabled: false, tableConfigured: false, tablePath: '' },
  channels: { wizardWrites: false },
  ui: { defaultBot: '', sectionOrder: [], rosterOrder: {}, userInitial: '', userName: '', hiddenProviders: [], subscriptionProviders: [], zeroSpendDefault: false, contrastAvatars: [], voiceModeName: '', replyListenButton: false },
  animatedBots: [],
  localChat: { name: '' },
  routines: { editable: true, eventTriggers: false },
  connectors: { enabled: true },
  computerPanel: { enabled: false },
}

let current = DEFAULT_APP_CONFIG
const listeners = new Set<() => void>()

const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '') : []
const text = (value: unknown) => typeof value === 'string' ? value : ''
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0

function parseQuotas(value: unknown): UsageQuotaConfig[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const raw = item as Record<string, unknown>
    const id = text(raw.id)
    if (!id) return []
    return [{
      id,
      label: text(raw.label) || id,
      windowHours: number(raw.windowHours) || 5,
      tokenLimit: number(raw.tokenLimit),
      modelPrefixes: strings(raw.modelPrefixes),
    }]
  })
}

export function parseAppConfig(value: unknown): AppConfig {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const ui = raw.ui && typeof raw.ui === 'object' ? raw.ui as Record<string, unknown> : {}
  const localChat = raw.localChat && typeof raw.localChat === 'object' ? raw.localChat as Record<string, unknown> : {}
  const sharedMemory = raw.sharedMemory && typeof raw.sharedMemory === 'object' ? raw.sharedMemory as Record<string, unknown> : {}
  const computerPanel = raw.computerPanel && typeof raw.computerPanel === 'object' ? raw.computerPanel as Record<string, unknown> : {}
  const features = raw.features && typeof raw.features === 'object' ? raw.features as Record<string, unknown> : {}
  const channels = raw.channels && typeof raw.channels === 'object' ? raw.channels as Record<string, unknown> : {}
  const rosterRaw = ui.rosterOrder && typeof ui.rosterOrder === 'object' && !Array.isArray(ui.rosterOrder) ? ui.rosterOrder as Record<string, unknown> : {}
  const rosterOrder: Record<string, string[]> = {}
  for (const [key, list] of Object.entries(rosterRaw)) {
    if (typeof key !== 'string' || !Array.isArray(list)) continue
    const slugs = list.filter((item): item is string => typeof item === 'string' && item !== '')
    if (slugs.length) rosterOrder[key] = slugs
  }
  return {
    channels: { wizardWrites: channels.wizardWrites === true },
    ui: {
      defaultBot: text(ui.defaultBot),
      sectionOrder: strings(ui.sectionOrder),
      rosterOrder,
      userInitial: text(ui.userInitial).slice(0, 2),
      userName: text(ui.userName),
      hiddenProviders: strings(ui.hiddenProviders),
      subscriptionProviders: strings(ui.subscriptionProviders),
      zeroSpendDefault: ui.zeroSpendDefault === true,
      contrastAvatars: strings(ui.contrastAvatars),
      voiceModeName: text(ui.voiceModeName).slice(0, 32),
      replyListenButton: ui.replyListenButton === true,
    },
    sharedMemory: {
      injectContext: sharedMemory.injectContext === true,
      types: strings(sharedMemory.types).length ? strings(sharedMemory.types) : (DEFAULT_APP_CONFIG.sharedMemory?.types ?? []),
    },
    features: {
      usageGlobal: features.usageGlobal !== false,
      vaultWallet: features.vaultWallet === true,
      pagesLibrary: features.pagesLibrary === true,
    },
    usageQuotas: parseQuotas(raw.usageQuotas),
    autoRouter: (() => {
      const row = raw.autoRouter && typeof raw.autoRouter === 'object' ? raw.autoRouter as Record<string, unknown> : {}
      return {
        enabled: row.enabled === true,
        tableConfigured: row.tableConfigured === true,
        tablePath: text(row.tablePath),
      }
    })(),
    animatedBots: strings(raw.animatedBots),
    localChat: { name: text(localChat.name) },
    routines: {
      editable: !(raw.routines && typeof raw.routines === 'object' && (raw.routines as Record<string, unknown>).editable === false),
      eventTriggers: Boolean(raw.routines && typeof raw.routines === 'object' && (raw.routines as Record<string, unknown>).eventTriggers === true),
    },
    connectors: { enabled: !(raw.connectors && typeof raw.connectors === 'object' && (raw.connectors as Record<string, unknown>).enabled === false) },
    computerPanel: { enabled: computerPanel.enabled === true },
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