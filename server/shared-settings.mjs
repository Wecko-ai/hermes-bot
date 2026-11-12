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
  return settings
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
