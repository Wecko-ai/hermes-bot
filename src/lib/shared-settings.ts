import { getSettings, subscribeSettings, updateSettings } from './settings'

/**
 * Settings every HermesBot app of this gateway shares (the iPhone app reads the same file): today the
 * hidden models. The local copy stays the one the window reads; the gateway's copy wins when it exists.
 */
const ROUTE = '/api/shared-settings'

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((item, index) => item === b[index])

let applying = false
let pushTimer: ReturnType<typeof setTimeout> | undefined
let lastShared: string[] | null = null
let watching = false

async function push(hiddenModels: string[]) {
  try {
    const response = await fetch(ROUTE, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hiddenModels }),
    })
    if (response.ok) lastShared = hiddenModels
  } catch { /* gateway away: the next sync writes it */ }
}

/** Reads the gateway's copy. Missing: this window's list becomes the shared one. */
export async function syncSharedSettings() {
  try {
    const response = await fetch(ROUTE, { credentials: 'same-origin' })
    if (!response.ok) return
    const body = await response.json() as { exists?: boolean; settings?: { hiddenModels?: unknown } }
    const shared = Array.isArray(body.settings?.hiddenModels) ? body.settings.hiddenModels.filter((key): key is string => typeof key === 'string') : null
    if (body.exists && shared) {
      lastShared = shared
      if (!sameList(shared, getSettings().hiddenModels)) {
        applying = true
        try { updateSettings({ hiddenModels: shared }) } finally { applying = false }
      }
    } else if (getSettings().hiddenModels.length) {
      await push(getSettings().hiddenModels)
    } else {
      lastShared = []
    }
  } catch { /* no server (demo, tests): local settings only */ }
  watch()
}

/** Every change made in this window goes to the gateway, grouped over a short pause. */
function watch() {
  if (watching) return
  watching = true
  subscribeSettings(() => {
    if (applying) return
    const { hiddenModels } = getSettings()
    if (lastShared && sameList(lastShared, hiddenModels)) return
    clearTimeout(pushTimer)
    pushTimer = setTimeout(() => { void push(getSettings().hiddenModels) }, 400)
  })
}
