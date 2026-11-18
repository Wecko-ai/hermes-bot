import { getSettings, updateSettings } from './settings'
import { settingsFromBody, type CompactionSettingsCopy } from './compaction'

/**
 * Settings every HermesBot app of this gateway shares (the iPhone app reads the same file): today the
 * hidden models. The local copy stays the one the window reads; the gateway's copy wins when it exists.
 *
 * Nothing is written on the fly: only the Save button of Settings > Models writes, and it sends this
 * window's own edits merged onto the gateway's latest copy. A window left open with an old list (the
 * other Mac) used to send its whole list back on any change, which hid again a model shown elsewhere.
 */
const ROUTE = '/api/shared-settings'

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((item, index) => item === b[index])

type SharedCopy = { exists: boolean; hiddenModels: string[]; compaction: CompactionSettingsCopy | null }

async function readShared(): Promise<SharedCopy | null> {
  try {
    const response = await fetch(ROUTE, { credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) return null
    const body = await response.json() as { exists?: boolean; settings?: { hiddenModels?: unknown; compaction?: unknown } }
    const list = Array.isArray(body.settings?.hiddenModels) ? body.settings.hiddenModels.filter((key): key is string => typeof key === 'string') : []
    return { exists: body.exists === true, hiddenModels: list, compaction: settingsFromBody(body.settings?.compaction) }
  } catch {
    return null
  }
}

async function writeShared(hiddenModels: string[]) {
  try {
    const response = await fetch(ROUTE, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hiddenModels }),
    })
    return response.ok
  } catch {
    return false
  }
}

function applyLocal(hiddenModels: string[]) {
  if (!sameList(hiddenModels, getSettings().hiddenModels)) updateSettings({ hiddenModels })
}

/**
 * The list a save writes: the gateway's latest copy, with only what this window changed since `baseline`
 * (the list its editor started from). Keys hidden or shown by another app in the meantime stay as they are.
 */
export function mergeHiddenModels(remote: string[], baseline: string[], draft: string[]) {
  const before = new Set(baseline)
  const after = new Set(draft)
  const shown = new Set(baseline.filter((key) => !after.has(key)))
  const merged = remote.filter((key) => !shown.has(key))
  const present = new Set(merged)
  for (const key of draft) {
    if (!before.has(key) && !present.has(key)) {
      merged.push(key)
      present.add(key)
    }
  }
  return merged
}

/** Reads the gateway's copy, which wins. Missing: this window's list becomes the shared one. */
export async function syncSharedSettings() {
  const shared = await readShared()
  if (!shared) return
  if (shared.compaction) {
    const { mode, gauge } = shared.compaction
    if (mode !== getSettings().compactionMode || gauge !== getSettings().compactionGauge) updateSettings({ compactionMode: mode, compactionGauge: gauge })
  }
  if (shared.exists) applyLocal(shared.hiddenModels)
  else if (getSettings().hiddenModels.length) await writeShared(getSettings().hiddenModels)
}

let lastPull = 0

/** A pull at most every `minGapMs`: on window focus, a list changed on the other Mac shows up here. */
export function pullSharedSettingsSoon(minGapMs = 15_000) {
  const now = Date.now()
  if (now - lastPull < minGapMs) return
  lastPull = now
  void syncSharedSettings()
}

/**
 * Saves the edits of Settings > Models. `local`: no gateway to share with (visual demo), the window's
 * copy only. Otherwise nothing is kept locally unless the gateway took it: an unsaved edit stays a draft.
 */
export async function saveHiddenModels(baseline: string[], draft: string[], { local = false } = {}): Promise<{ ok: boolean; hiddenModels: string[] }> {
  if (local) {
    const hiddenModels = mergeHiddenModels(getSettings().hiddenModels, baseline, draft)
    applyLocal(hiddenModels)
    return { ok: true, hiddenModels }
  }
  const shared = await readShared()
  if (!shared) return { ok: false, hiddenModels: draft }
  const hiddenModels = mergeHiddenModels(shared.exists ? shared.hiddenModels : getSettings().hiddenModels, baseline, draft)
  if (!await writeShared(hiddenModels)) return { ok: false, hiddenModels: draft }
  applyLocal(hiddenModels)
  return { ok: true, hiddenModels }
}
