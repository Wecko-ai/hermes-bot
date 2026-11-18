/**
 * Model scores from Artificial Analysis (https://artificialanalysis.ai/), for the model picker.
 * Only this server talks to their API: the page never sees the key and its CSP does not list the host.
 * The key lives encrypted with `safeStorage` in the macOS app (see electron/main.cjs); outside the app,
 * only the ARTIFICIAL_ANALYSIS_API_KEY environment variable is accepted. The key is never logged or returned.
 * Attribution to Artificial Analysis is required by their terms: the UI shows a link.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const API_HOST = 'https://artificialanalysis.ai'
// Free tier. The older list endpoint is tried when this one is gone (404/410).
const ENDPOINTS = ['/api/v2/language/models/free', '/api/v2/data/llms/models']
const PAGE_SIZE = 200
const MAX_PAGES = 5
const MAX_BYTES = 8 * 1024 * 1024
const TIMEOUT_MS = 15_000
export const SCORES_TTL_MS = 24 * 60 * 60 * 1000
// The free quota is small (100 requests per 24 h): after a failure, wait before trying again.
const RETRY_AFTER_FAILURE_MS = 15 * 60 * 1000
const KEY_PATTERN = /^[A-Za-z0-9_.-]{8,200}$/

const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : undefined)
const text = (value, max = 120) => (typeof value === 'string' ? value.trim().slice(0, max) : '')

/** One API entry to the compact shape, or `null` when it has no usable name or score. */
export function compactModel(entry) {
  if (!entry || typeof entry !== 'object') return null
  const slug = text(entry.slug)
  const name = text(entry.name)
  const evaluations = entry.evaluations && typeof entry.evaluations === 'object' ? entry.evaluations : {}
  const intelligence = number(evaluations.artificial_analysis_intelligence_index)
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slug) || !name || intelligence === undefined) return null
  const pricing = entry.pricing && typeof entry.pricing === 'object' ? entry.pricing : {}
  const performance = entry.performance && typeof entry.performance === 'object' ? entry.performance : {}
  const input = number(pricing.price_1m_input_tokens)
  const output = number(pricing.price_1m_output_tokens)
  // Blended price, 3 parts input for 1 part output (the ratio Artificial Analysis uses).
  const blended = number(pricing.price_1m_blended_3_to_1) ?? (input !== undefined && output !== undefined ? number((3 * input + output) / 4) : undefined)
  const model = { slug, name, creator: text(entry.model_creator?.name, 60), intelligence }
  const optional = {
    coding: number(evaluations.artificial_analysis_coding_index),
    agentic: number(evaluations.artificial_analysis_agentic_index),
    engineering: number(evaluations.artificial_analysis_engineering_index),
    outputSpeed: number(performance.median_output_tokens_per_second ?? entry.median_output_tokens_per_second),
    priceBlended: blended,
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

function readCache(file) {
  if (!file) return null
  try {
    const body = JSON.parse(readFileSync(file, 'utf8'))
    const models = compactModels(body?.models)
    const fetchedAt = Number(body?.fetchedAt)
    return models.length && Number.isFinite(fetchedAt) ? { fetchedAt, models } : null
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

/**
 * `keyStore`: `{ load(): string, save(text), clear() }` over the encrypted file, or `null` where the OS gives
 * no encryption (browser mode: no key is stored). `cacheFile`: where the validated list is kept (not secret).
 */
export function createModelScores({ keyStore = null, cacheFile = '', env = process.env, fetchImpl = fetch, now = Date.now, apiOrigin = API_HOST } = {}) {
  let cache = readCache(cacheFile)
  let inFlight = null
  let lastFailure = -Infinity
  let lastError = ''

  function storedKey() {
    if (!keyStore) return ''
    try {
      const value = keyStore.load()
      return typeof value === 'string' && KEY_PATTERN.test(value.trim()) ? value.trim() : ''
    } catch {
      return ''
    }
  }
  const envKey = () => (KEY_PATTERN.test((env.ARTIFICIAL_ANALYSIS_API_KEY || '').trim()) ? env.ARTIFICIAL_ANALYSIS_API_KEY.trim() : '')
  const currentKey = () => storedKey() || envKey()

  function status() {
    const source = storedKey() ? 'stored' : envKey() ? 'env' : 'none'
    return { configured: source !== 'none', keySource: source, canStore: Boolean(keyStore) }
  }

  async function fetchPage(endpoint, page, key) {
    const url = `${apiOrigin}${endpoint}?page=${page}&page_size=${PAGE_SIZE}`
    const response = await fetchImpl(url, { headers: { 'x-api-key': key, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' })
    return { status: response.status, ok: response.ok, body: response.ok ? await readCapped(response) : null }
  }

  async function download(key) {
    for (const endpoint of ENDPOINTS) {
      const entries = []
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const result = await fetchPage(endpoint, page, key)
        if (!result.ok) {
          if (page === 1 && (result.status === 404 || result.status === 410)) break
          throw new Error(result.status === 401 || result.status === 403 ? 'invalid_key' : result.status === 429 ? 'rate_limited' : 'upstream_failed')
        }
        entries.push(...(Array.isArray(result.body?.data) ? result.body.data : []))
        if (!result.body?.pagination?.has_more) return compactModels(entries)
      }
      if (entries.length) return compactModels(entries)
    }
    throw new Error('upstream_failed')
  }

  async function refresh() {
    const key = currentKey()
    if (!key) return
    try {
      const models = await download(key)
      if (!models.length) throw new Error('empty')
      cache = { fetchedAt: now(), models }
      lastError = ''
      writeCache(cacheFile, cache)
    } catch (error) {
      lastFailure = now()
      // Only a short code: an error from `fetch` could carry the request headers.
      lastError = ['invalid_key', 'rate_limited', 'too_large'].includes(error?.message) ? error.message : 'upstream_failed'
    }
  }

  /** The list for the page. Fresh for 24 h, served stale when the API fails; one request at a time. */
  async function get() {
    const state = status()
    const fresh = cache && now() - cache.fetchedAt < SCORES_TTL_MS
    if (state.configured && !fresh && now() - lastFailure > RETRY_AFTER_FAILURE_MS) {
      inFlight ??= refresh().finally(() => { inFlight = null })
      await inFlight
    }
    const body = { ...state, source: 'Artificial Analysis', updatedAt: cache ? new Date(cache.fetchedAt).toISOString() : '', models: cache?.models ?? [] }
    if (!state.configured && !cache) return { ...body, keyMissing: true }
    if (!state.configured) return { ...body, keyMissing: true, models: [] }
    return lastError ? { ...body, error: lastError } : body
  }

  /** Stores the key, encrypted. Refused where nothing encrypts it. */
  function setKey(value) {
    const key = typeof value === 'string' ? value.trim() : ''
    if (!KEY_PATTERN.test(key)) return 'invalid_key'
    if (!keyStore) return 'storage_unavailable'
    try {
      keyStore.save(key)
    } catch {
      return 'storage_failed'
    }
    lastFailure = -Infinity
    lastError = ''
    return ''
  }

  function removeKey() {
    try { keyStore?.clear() } catch { return 'storage_failed' }
    cache = null
    writeCache(cacheFile, { fetchedAt: 0, models: [] })
    return ''
  }

  return { get, status, setKey, removeKey }
}
