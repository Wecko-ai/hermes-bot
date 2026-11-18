import { compactionFrom } from './compaction.mjs'

// Settings shared by every HermesBot app of one gateway (Mac and iPhone): a file on the gateway's
// machine, read and written through its own file routes. The path is fixed here: no client names it.
export const SHARED_SETTINGS_PATH = '~/.hermes/hermesbot-settings.json'
export const SHARED_SETTINGS_MAX_BYTES = 256 * 1024

/** The shared settings kept from a body: only known fields, of the right type. */
export function sharedSettingsFrom(value) {
  const settings = {}
  if (value && typeof value === 'object' && Array.isArray(value.hiddenModels)) {
    settings.hiddenModels = [...new Set(value.hiddenModels.filter((key) => typeof key === 'string' && key.length > 0 && key.length < 400))].slice(0, 5000)
  }
  const compaction = compactionFrom(value?.compaction)
  if (compaction && typeof value.compaction === 'object') settings.compaction = compaction
  return settings
}

/**
 * The settings a PUT writes: the body's own fields, with the compaction setting always the file's.
 * The compaction setting (with its snapshots) is written only by `/api/compaction`, never by this route.
 */
export function withKeptCompaction(existing, body) {
  const own = { ...body }
  delete own.compaction
  return existing?.compaction ? { ...own, compaction: existing.compaction } : own
}

/** The file's text: versioned, readable by hand. */
export const sharedSettingsText = (settings) => `${JSON.stringify({ version: 1, ...sharedSettingsFrom(settings) }, null, 2)}\n`

/** The file read back; an unreadable one counts as empty. */
export function parseSharedSettings(text) {
  try {
    return sharedSettingsFrom(JSON.parse(String(text || '{}')))
  } catch {
    return {}
  }
}

async function discard(upstream) {
  await upstream?.body?.cancel?.().catch(() => {})
}

/** Every return path drops the upstream body, including a 404 and a successful write. */
export async function relaySharedSettingsGet(upstream) {
  try {
    if (upstream.status === 404) return { status: 200, body: { exists: false, settings: {} } }
    if (!upstream.ok) return { status: upstream.status, body: { error: 'shared_settings_unreadable' } }
    const body = await upstream.json().catch(() => ({}))
    return { status: 200, body: { exists: true, settings: parseSharedSettings(body.text) } }
  } finally {
    await discard(upstream)
  }
}

export async function relaySharedSettingsPut(upstream, settings) {
  try {
    if (!upstream.ok) return { status: upstream.status, body: { error: 'shared_settings_unwritable' } }
    return { status: 200, body: { ok: true, settings } }
  } finally {
    await discard(upstream)
  }
}
