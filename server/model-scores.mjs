/**
 * Model scores from LLM Stats (https://llm-stats.com/), for the model picker.
 * Only this server talks to the API: the page never sees the key and its CSP does not list the host.
 * The key comes from LLM_STATS_API_KEY or the macOS Keychain; it is never logged or returned.
 * An optional local snapshot provides offline data. Fresh top-50 entries are merged over it.
 * Attribution to LLM Stats is required by its terms: the UI always shows "Data by LLM Stats" and a link.
 */
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const API_HOST = 'https://api.llm-stats.com'
const RANKINGS_PATH = '/stats/v1/rankings?category=general&limit=50'
const MAX_BYTES = 4 * 1024 * 1024
const TIMEOUT_MS = 15_000
export const SCORES_TTL_MS = 24 * 60 * 60 * 1000
// Community has a daily response quota: one top-50 response per day, and no immediate retry storm.
const RETRY_AFTER_FAILURE_MS = 15 * 60 * 1000
const KEY_PATTERN = /^[A-Za-z0-9_.-]{8,200}$/
const KEYCHAIN_SERVICE = 'hermesbot-llm-stats-api-key'
const KEYCHAIN_ACCOUNT = 'hermesbot'
const SECRET_OUTPUT_MAX_BYTES = 4 * 1024
const KEYCHAIN_TIMEOUT_MS = 5_000
const KEY_COMMAND_TIMEOUT_MS = 15_000

const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : undefined)
const text = (value, max = 120) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
const validKey = (value) => typeof value === 'string' && KEY_PATTERN.test(value.trim()) ? value.trim() : ''

function categoryScore(categories, names) {
  if (!categories || typeof categories !== 'object' || Array.isArray(categories)) return undefined
  for (const name of names) {
    const score = number(categories[name]?.score ?? categories[name]?.conservative_rating)
    if (score !== undefined) return score
  }
  return undefined
}

/** One API, cache or snapshot entry to the compact shape, or `null` when it has no usable name or score. */
export function compactModel(entry) {
  if (!entry || typeof entry !== 'object') return null
  const slug = text(entry.model_id || entry.slug || entry.id)
  const name = text(entry.model_name || entry.name)
  const intelligence = number(entry.conservative_rating ?? entry.intelligence ?? entry.score)
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slug) || !name || intelligence === undefined) return null
  const model = {
    slug,
    name,
    creator: text(entry.organization || entry.org || entry.creator, 60),
    intelligence,
  }
  const optional = {
    coding: categoryScore(entry.categories, ['coding', 'code', 'frontend_development']) ?? number(entry.coding),
    agentic: categoryScore(entry.categories, ['agents', 'tool_calling']) ?? number(entry.agentic),
  }
  for (const [key, value] of Object.entries(optional)) if (value !== undefined) model[key] = value
  return model
}

export function compactModels(entries) {
  const seen = new Set()
  const models = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    const model = compactModel(entry)
    if (!model || seen.has(model.slug)) continue
    seen.add(model.slug)
    models.push(model)
  }
  return models
}

/** Overlay fresher general scores while retaining category scores absent from the rankings response. */
export function mergeModels(baseEntries, freshEntries) {
  const merged = new Map()
  for (const model of [...compactModels(baseEntries), ...compactModels(freshEntries)]) {
    const previous = merged.get(model.slug)
    merged.set(model.slug, previous ? {
      ...model,
      coding: model.coding ?? previous.coding,
      agentic: model.agentic ?? previous.agentic,
    } : model)
  }
  return [...merged.values()]
}

function readCache(file) {
  if (!file) return null
  try {
    const body = JSON.parse(readFileSync(file, 'utf8'))
    const models = compactModels(body?.models)
    const fetchedAt = Number(body?.fetchedAt)
    return models.length && Number.isFinite(fetchedAt) ? { fetchedAt, models, quota: sanitizeQuota(body?.quota) } : null
  } catch {
    return null
  }
}

function readSnapshot(file) {
  if (!file) return null
  try {
    const body = JSON.parse(readFileSync(file, 'utf8'))
    if (!body || body.placeholder === true) return null
    // The detailed list carries category scores; top carries the freshest general ranking.
    const models = mergeModels(body.models, body.top)
    const stamp = Date.parse(body.generatedAt || body.snapshot || '')
    return models.length ? { models, updatedAt: Number.isFinite(stamp) ? new Date(stamp).toISOString() : '' } : null
  } catch {
    return null
  }
}

function writeCache(file, cache) {
  if (!file) return
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    const temporary = `${file}.tmp`
    writeFileSync(temporary, JSON.stringify(cache), { mode: 0o600 })
    renameSync(temporary, file)
  } catch {
    // A cache that cannot be written only costs one more request tomorrow.
  }
}

async function readCapped(response) {
  const declared = Number(response.headers.get('content-length'))
  if (declared > MAX_BYTES) throw new Error('too_large')
  const body = await response.text()
  if (body.length > MAX_BYTES) throw new Error('too_large')
  return JSON.parse(body)
}

function sanitizeQuota(value) {
  if (!value || typeof value !== 'object') return null
  const quota = {}
  for (const key of ['limit', 'remaining', 'used']) {
    const raw = value[key]
    const found = raw === null || raw === undefined || raw === '' ? null : Number(raw)
    quota[key] = found !== null && Number.isFinite(found) && found >= 0 ? found : null
  }
  return Object.values(quota).some((value) => value !== null) ? quota : null
}

function responseQuota(headers) {
  return sanitizeQuota({
    limit: headers.get('x-quota-limit'),
    remaining: headers.get('x-quota-remaining'),
    used: headers.get('x-quota-used'),
  })
}

function execSecret(command, timeout) {
  return new Promise((resolve) => {
    execFile(command[0], command.slice(1), {
      timeout,
      maxBuffer: SECRET_OUTPUT_MAX_BYTES,
      windowsHide: true,
      shell: false,
    }, (error, stdout) => resolve(error ? '' : stdout))
  })
}

function readKeychainWithSecurity() {
  return execSecret(['/usr/bin/security', 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'], KEYCHAIN_TIMEOUT_MS)
}

function readKeyCommand(command) {
  return execSecret(command, KEY_COMMAND_TIMEOUT_MS)
}

function validCommand(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 32
    && value.every((argument) => typeof argument === 'string' && argument.trim().length > 0 && argument.length <= 128)
    && path.isAbsolute(value[0]) ? value : null
}

/**
 * `snapshotFile`: optional display-only LLM Stats snapshot. `cacheFile`: validated API data only, never a secret.
 * `keyCommand`: trusted installation argv whose stdout is the key. No shell, fixed timeout and output cap.
 * Readers are injectable for tests; production uses `execFile` without logging stdout, stderr or errors.
 */
export function createModelScores({ cacheFile = '', snapshotFile = '', keyCommand = null, env = process.env, fetchImpl = fetch, now = Date.now, apiOrigin = API_HOST, readKeychain = readKeychainWithSecurity, readCommand = readKeyCommand } = {}) {
  const command = validCommand(keyCommand)
  let cache = readCache(cacheFile)
  const snapshot = readSnapshot(snapshotFile)
  let inFlight = null
  let lastFailure = -Infinity
  let lastError = ''

  async function currentKey() {
    if (command) {
      try {
        const fromCommand = validKey(await readCommand(command))
        if (fromCommand) return { key: fromCommand, keySource: 'command' }
      } catch {
        // A failed trusted command falls through without exposing its output.
      }
    }
    const fromEnv = validKey(env.LLM_STATS_API_KEY)
    if (fromEnv) return { key: fromEnv, keySource: 'env' }
    try {
      const fromKeychain = validKey(await readKeychain())
      if (fromKeychain) return { key: fromKeychain, keySource: 'keychain' }
    } catch {
      // No usable Keychain item: generic installs simply show no fresh scores.
    }
    return { key: '', keySource: 'none' }
  }

  async function status() {
    const { keySource } = await currentKey()
    return { configured: keySource !== 'none', keySource }
  }

  async function download(key) {
    const response = await fetchImpl(`${apiOrigin}${RANKINGS_PATH}`, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    })
    const quota = responseQuota(response.headers)
    if (!response.ok) {
      const error = new Error(response.status === 401 || response.status === 403 ? 'invalid_key' : response.status === 429 ? 'rate_limited' : 'upstream_failed')
      error.quota = quota
      throw error
    }
    const body = await readCapped(response)
    return { models: compactModels(body?.models), quota }
  }

  async function refresh(key) {
    try {
      const { models, quota } = await download(key)
      if (!models.length) throw new Error('empty')
      cache = { fetchedAt: now(), models, quota }
      lastError = ''
      writeCache(cacheFile, cache)
    } catch (error) {
      lastFailure = now()
      if (error?.quota) cache = { ...(cache || { fetchedAt: 0, models: [] }), quota: error.quota }
      // Only a short code: an error from `fetch` could carry the request headers.
      lastError = ['invalid_key', 'rate_limited', 'too_large'].includes(error?.message) ? error.message : 'upstream_failed'
    }
  }

  /** Fresh for 24 h, stale data kept when the API fails; at most one top-50 request at a time. */
  async function get() {
    const { key, keySource } = await currentKey()
    const fresh = cache && cache.models.length && now() - cache.fetchedAt < SCORES_TTL_MS
    if (key && !fresh && now() - lastFailure > RETRY_AFTER_FAILURE_MS) {
      inFlight ??= refresh(key).finally(() => { inFlight = null })
      await inFlight
    }
    const models = mergeModels(snapshot?.models ?? [], cache?.models ?? [])
    const updatedAt = cache?.models.length ? new Date(cache.fetchedAt).toISOString() : snapshot?.updatedAt || ''
    const body = {
      configured: Boolean(key),
      keySource,
      keyMissing: !key,
      source: 'LLM Stats',
      updatedAt,
      quota: cache?.quota ?? null,
      models,
    }
    return lastError ? { ...body, error: lastError } : body
  }

  return { get, status }
}
