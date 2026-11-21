import { getSettings, updateSettings } from './settings'
import { settingsFromBody, type CompactionSettingsCopy } from './compaction'
import { getAppConfig } from './app-config'

/**
 * Settings every HermesBot app of this gateway shares (the iPhone app reads the same file): hidden models
 * and zero-spend mode. The local copy stays the one the window reads; the gateway's copy wins when it exists.
 *
 * Hidden-model changes wait for the Save button of Settings > Models. Zero-spend changes save at once. Both
 * re-read the latest shared copy and carry its other fields, so one setting does not overwrite the other.
 */
const ROUTE = '/api/shared-settings'

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((item, index) => item === b[index])

type SharedCopy = { exists: boolean; hiddenModels: string[]; zeroSpend: boolean | null; compaction: CompactionSettingsCopy | null }
type SharedWrite = { hiddenModels: string[]; zeroSpend?: boolean }

async function readShared(): Promise<SharedCopy | null> {
  try {
    const response = await fetch(ROUTE, { credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) return null
    const body = await response.json() as { exists?: boolean; settings?: { hiddenModels?: unknown; zeroSpend?: unknown; compaction?: unknown } }
    const list = Array.isArray(body.settings?.hiddenModels) ? body.settings.hiddenModels.filter((key): key is string => typeof key === 'string') : []
    return {
      exists: body.exists === true,
      hiddenModels: list,
      zeroSpend: typeof body.settings?.zeroSpend === 'boolean' ? body.settings.zeroSpend : null,
      compaction: settingsFromBody(body.settings?.compaction),
    }
  } catch {
    return null
  }
}

async function writeShared(settings: SharedWrite) {
  try {
    const response = await fetch(ROUTE, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    })
    return response.ok
  } catch {
    return false
  }
}

function applyLocal(hiddenModels: string[]) {
  if (!sameList(hiddenModels, getSettings().hiddenModels)) updateSettings({ hiddenModels })
}

function applyZeroSpend(zeroSpend: boolean) {
  if (zeroSpend !== getSettings().freeMode) updateSettings({ freeMode: zeroSpend })
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
  if (shared.zeroSpend !== null) applyZeroSpend(shared.zeroSpend)
  else applyZeroSpend(getSettings().freeMode || getAppConfig().ui.zeroSpendDefault)
  if (shared.exists) applyLocal(shared.hiddenModels)
  else if (getSettings().hiddenModels.length) await writeShared({ hiddenModels: getSettings().hiddenModels })
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
  const next: SharedWrite = { hiddenModels }
  if (shared.zeroSpend !== null) next.zeroSpend = shared.zeroSpend
  if (!await writeShared(next)) return { ok: false, hiddenModels: draft }
  applyLocal(hiddenModels)
  return { ok: true, hiddenModels }
}

/** Saves the global zero-spend choice at once. A failed write leaves the previous local mirror untouched. */
export async function saveZeroSpend(zeroSpend: boolean, { local = false } = {}): Promise<boolean> {
  if (local) {
    applyZeroSpend(zeroSpend)
    return true
  }
  const shared = await readShared()
  if (!shared) return false
  const saved = await writeShared({
    hiddenModels: shared.exists ? shared.hiddenModels : getSettings().hiddenModels,
    zeroSpend,
  })
  if (!saved) return false
  applyZeroSpend(zeroSpend)
  return true
}
