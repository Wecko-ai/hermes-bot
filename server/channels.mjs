// Channel wizard: env key presence only (never values), optional non-secret config merge.

import path from 'node:path'

const PROFILE_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/
const ENV_KEY = /^[A-Z][A-Z0-9_]{0,127}$/

/** Keys we look for in a profile `.env` (names only). */
export const PLATFORM_ENV = {
  telegram: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USERS', 'TELEGRAM_HOME_CHANNEL', 'TELEGRAM_REPLY_TO_MODE'],
  slack: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_ALLOWED_USERS', 'SLACK_HOME_CHANNEL'],
  imessage: ['BLUEBUBBLES_SERVER_URL', 'BLUEBUBBLES_PASSWORD', 'BLUEBUBBLES_ALLOWED_USERS', 'BLUEBUBBLES_HOME_CHANNEL'],
}

const REQUIRED = {
  telegram: new Set(['TELEGRAM_BOT_TOKEN']),
  slack: new Set(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']),
  imessage: new Set(['BLUEBUBBLES_SERVER_URL', 'BLUEBUBBLES_PASSWORD']),
}

const ENV_VALUE = /^[^\s#][^\r\n]*$/
const ENV_VALUE_MAX = 4096

const CONFIG_PATCH = {
  telegram: { platforms: { telegram: { enabled: true } } },
  slack: { platforms: { slack: { enabled: true } } },
  imessage: { platforms: { bluebubbles: { enabled: true } } },
}

const ALL_WATCHED = [...new Set(Object.values(PLATFORM_ENV).flat())]

/** Parse `.env` text: return defined key names only, never values. */
export function envKeysPresent(text) {
  const found = new Set()
  if (typeof text !== 'string') return found
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 1) continue
    const key = trimmed.slice(0, eq).trim()
    if (!ENV_KEY.test(key)) continue
    const value = trimmed.slice(eq + 1).trim()
    if (!value) continue
    found.add(key)
  }
  return found
}

export function profileEnvPath(hermesHome, slug) {
  return path.join(hermesHome, 'profiles', slug, '.env')
}

export function profileConfigPath(hermesHome, slug) {
  return path.join(hermesHome, 'profiles', slug, 'config.yaml')
}

export function backupPath(targetPath, timestamp = Date.now()) {
  const stamp = new Date(timestamp).toISOString().replace(/[:.]/g, '-')
  return `${targetPath}.bak-${stamp}`
}

export function channelStatusFromKeys(presentKeys) {
  const present = new Set(presentKeys.filter((key) => ALL_WATCHED.includes(key)))
  const platforms = Object.keys(PLATFORM_ENV).map((platform) => {
    const names = PLATFORM_ENV[platform]
    const missingRequired = [...(REQUIRED[platform] || [])].filter((key) => !present.has(key))
    return {
      platform,
      ready: missingRequired.length === 0,
      missingRequired,
      present: names.filter((key) => present.has(key)),
    }
  })
  const snippet = Object.keys(PLATFORM_ENV).map((platform) => {
    const lines = [`# ${platform}`, '# Profile .env (set values on the gateway machine):']
    for (const name of PLATFORM_ENV[platform]) {
      const mark = present.has(name) ? 'ok' : (REQUIRED[platform]?.has(name) ? 'required' : 'optional')
      lines.push(`#   ${name} (${mark})`)
    }
    return lines.join('\n')
  }).join('\n\n')
  return { platforms, snippet }
}

export function allowedPlatform(value) {
  return value === 'telegram' || value === 'slack' || value === 'imessage' ? value : null
}

export function configPatchFor(platform) {
  return CONFIG_PATCH[platform] || null
}

export function validateChannelRequest(body) {
  const profile = typeof body?.profile === 'string' && PROFILE_SLUG.test(body.profile) ? body.profile : null
  const platform = allowedPlatform(body?.platform)
  if (!profile || !platform) return null
  return { profile, platform }
}

/** Parse `.env` into key/value pairs (values only kept in memory for merge writes, never logged). */
export function parseEnvText(text) {
  const lines = typeof text === 'string' ? text.split('\n') : []
  const entries = new Map()
  const order = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      order.push({ kind: 'raw', line })
      continue
    }
    const eq = trimmed.indexOf('=')
    if (eq < 1) {
      order.push({ kind: 'raw', line })
      continue
    }
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (!ENV_KEY.test(key)) {
      order.push({ kind: 'raw', line })
      continue
    }
    if (!entries.has(key)) order.push({ kind: 'kv', key })
    entries.set(key, value)
  }
  return { entries, order }
}

export function mergeEnvText(text, updates) {
  const allowed = Object.entries(updates || {}).filter(([key, value]) => ENV_KEY.test(key) && typeof value === 'string' && value.length > 0 && value.length <= ENV_VALUE_MAX && ENV_VALUE.test(value))
  if (!allowed.length) return null
  const { entries, order } = parseEnvText(text || '')
  for (const [key, value] of allowed) entries.set(key, value)
  const lines = []
  const seen = new Set()
  for (const item of order) {
    if (item.kind === 'raw') {
      lines.push(item.line)
      continue
    }
    if (seen.has(item.key)) continue
    seen.add(item.key)
    lines.push(`${item.key}=${entries.get(item.key) ?? ''}`)
  }
  for (const [key] of allowed) {
    if (seen.has(key)) continue
    lines.push(`${key}=${entries.get(key) ?? ''}`)
  }
  const body = lines.join('\n')
  if (body.length && !body.endsWith('\n')) return `${body}\n`
  return body || `${allowed.map(([key, value]) => `${key}=${value}`).join('\n')}\n`
}

export function validateChannelEnvBody(body) {
  const base = validateChannelRequest(body)
  if (!base) return null
  const allowedKeys = new Set(PLATFORM_ENV[base.platform] || [])
  const env = {}
  const raw = body?.env && typeof body.env === 'object' && !Array.isArray(body.env) ? body.env : null
  if (!raw) return null
  for (const [key, value] of Object.entries(raw)) {
    if (!allowedKeys.has(key) || typeof value !== 'string') return null
    const trimmed = value.trim()
    if (!trimmed || trimmed.length > ENV_VALUE_MAX || !ENV_VALUE.test(trimmed)) return null
    env[key] = trimmed
  }
  if (!Object.keys(env).length) return null
  return { ...base, env }
}