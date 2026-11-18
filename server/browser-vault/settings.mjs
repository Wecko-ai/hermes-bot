import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { BrowserVaultError } from './errors.mjs'

/**
 * Vault settings chosen by the user in the app (Settings, Vault). Only the vault reads them, at each
 * bot command: the app never decides for the vault. Any doubt (missing, unreadable, foreign or
 * group-writable file, unknown value) gives the defaults: every sign-up waits for the user's card,
 * and each credential stays reserved for the bots chosen for it.
 * - `autoSignup`: sign-ups go through without a card.
 * - `shareCredentials`: every bot may list and fill every stored credential, whatever its bot list.
 */
export const DEFAULT_SETTINGS = Object.freeze({ autoSignup: false, shareCredentials: false })

/** Known keys only, strict booleans: anything else is the default. */
export function parseSettings(value) {
  return { autoSignup: value?.autoSignup === true, shareCredentials: value?.shareCredentials === true }
}

/** What the app sends: every key it changes must be a boolean, unknown keys are refused. */
export function settingsPatch(body) {
  const keys = Object.keys(body || {})
  if (!keys.length || keys.some((key) => !(key in DEFAULT_SETTINGS) || typeof body[key] !== 'boolean')) {
    throw new BrowserVaultError('invalid_settings', 400)
  }
  return Object.fromEntries(keys.map((key) => [key, body[key]]))
}

/** In memory only: unit tests and a vault started without a settings file. */
export function memorySettings(initial = {}) {
  let current = parseSettings({ ...DEFAULT_SETTINGS, ...initial })
  return {
    get: () => ({ ...current }),
    set: async (patch) => {
      current = parseSettings({ ...current, ...settingsPatch(patch) })
      return { ...current }
    },
  }
}

function readSettingsFile(file) {
  try {
    const info = fs.statSync(file)
    // Placed by another account or open to others: ignored, like the admin token.
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) return { ...DEFAULT_SETTINGS }
    return parseSettings(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/**
 * Settings file of the vault's account (`0600`, atomic write). Read once at start, then kept in
 * memory: only the admin API (token and the user's Hermes session) changes it.
 */
export function fileSettings(file) {
  let current = readSettingsFile(file)
  return {
    get: () => ({ ...current }),
    set: async (patch) => {
      const next = parseSettings({ ...current, ...settingsPatch(patch) })
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`
      try {
        const handle = fs.openSync(temporary, 'wx', 0o600)
        try { fs.writeSync(handle, `${JSON.stringify(next)}\n`) } finally { fs.closeSync(handle) }
        fs.renameSync(temporary, file)
      } catch {
        fs.rmSync(temporary, { force: true })
        throw new BrowserVaultError('settings_write_failed', 503)
      }
      current = next
      return { ...current }
    },
  }
}
