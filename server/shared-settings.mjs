import { compactionFrom } from './compaction.mjs'

// Settings shared by every HermesBot app of one gateway (Mac and iPhone): a file on the gateway's
// machine, read and written through its own file routes. The path is fixed here: no client names it.
export const SHARED_SETTINGS_PATH = '~/.hermes/hermesbot-settings.json'
export const SHARED_SETTINGS_MAX_BYTES = 256 * 1024

// The scoring table the phone reads through the gateway. Absolute or ~/ only: a relative path would
// be resolved against whatever directory the gateway happened to use.
const TABLE_PATH = /^(?:\/|~\/)[^\u0000-\u001f]{1,4096}$/

/** Auto capability stored in the shared file. Log directory stays on the desktop server. */
export function autoRouterFrom(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.enabled !== true && value.enabled !== false) return null
  const row = { enabled: value.enabled === true }
  if (typeof value.tablePath === 'string' && TABLE_PATH.test(value.tablePath)) row.tablePath = value.tablePath
  return row
}

/** The shared settings kept from a body: only known fields, of the right type. */
export function sharedSettingsFrom(value) {
  const settings = {}
  if (value && typeof value === 'object' && Array.isArray(value.hiddenModels)) {
    settings.hiddenModels = [...new Set(value.hiddenModels.filter((key) => typeof key === 'string' && key.length > 0 && key.length < 400))].slice(0, 5000)
  }
  if (typeof value?.zeroSpend === 'boolean') settings.zeroSpend = value.zeroSpend
  const compaction = compactionFrom(value?.compaction)
  if (compaction && typeof value.compaction === 'object') settings.compaction = compaction
  const autoRouter = autoRouterFrom(value?.autoRouter)
  if (autoRouter) settings.autoRouter = autoRouter
  return settings
}

/**
 * The settings a PUT writes: the body's own fields, with protected fields kept from the file.
 * Compaction (with its snapshots) is written only by `/api/compaction`. An old client that writes only
 * hiddenModels must not erase zeroSpend; turning it off always sends the explicit boolean false.
 * The same applies to autoRouter, which the Mac window never sends.
 */
export function withKeptCompaction(existing, body) {
  const own = { ...body }
  delete own.compaction
  if (typeof own.zeroSpend !== 'boolean' && typeof existing?.zeroSpend === 'boolean') own.zeroSpend = existing.zeroSpend
  // A settings save from the Mac window does not send autoRouter. Keep the copy the server published.
  if (!own.autoRouter && existing?.autoRouter) own.autoRouter = existing.autoRouter
  return existing?.compaction ? { ...own, compaction: existing.compaction } : own
}

/** Replaces whatever the client sent with the server's own Auto capability. */
export function withPublishedAutoRouter(settings, published) {
  const row = autoRouterFrom(published)
  if (!row) return settings
  return { ...settings, autoRouter: row }
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
