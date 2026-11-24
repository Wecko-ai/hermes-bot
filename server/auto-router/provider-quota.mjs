import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chargeFor, quotaSource, utcDay } from './quota.mjs'

/**
 * Shared provider quota file (`provider-quota.json` in the auto-router log dir).
 *
 * Every provider Auto routes to is counted, including ones with no cap.
 * `daily-quota.json` is read once when this file does not exist yet.
 * Writes are atomic (temp file + rename). Concurrent writers are merged by
 * max(used) inside the same window; a newer window replaces the older count.
 * `provider-quota-pro.json` beside it is optional and read-only.
 *
 * NVIDIA does not fit one window: the contract fields track the 40/minute
 * rate limit, and `dayUsed` / `dayLimit` / `dayStart` keep the ~10_000/day cap.
 * Those extra fields are kept when another writer omits them.
 *
 * A provider may also carry `models`, keyed by the model id (the last path
 * segment, e.g. `claude-opus-5-5`). A model entry is
 * `{ exhaustedUntil, lastStatus, lastError, lastErrorAt }`. Writers merge it
 * like the provider row: the later `exhaustedUntil` wins, and the newer error
 * text is kept. A model-scoped quota error fills only that entry. A
 * provider-wide error still sets the provider `exhaustedUntil` and blocks
 * every model. Old readers ignore `models`.
 */

export const PROVIDER_QUOTA_FILE = 'provider-quota.json'
export const PROVIDER_QUOTA_PRO_FILE = 'provider-quota-pro.json'
export const RECENT_PICKS_MAX = 50
/** Gateway `cli-quota.mjs` prefers the store with the highest contract. */
export const QUOTA_GATEWAY_CONTRACT = 2
/** Cursor's reset time is not in the proxy error. Re-probe after this. */
export const CURSOR_UNKNOWN_EXHAUST_MS = 6 * 60 * 60 * 1000
/** Retired or removed model (HTTP 410 / end of life): cool down that model alone for a day. */
export const MODEL_GONE_EXHAUST_MS = 24 * 60 * 60 * 1000
/** Single-model upstream rate limit (e.g. an aggregator `:free` route): short per-model pause. */
export const UPSTREAM_MODEL_RATE_MS = 10 * 60 * 1000
/** A completion this soon after an Auto reserve is the same request. */
const RESERVE_MATCH_MS = 15000

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
const LOCAL = new Set([
  'omlx', 'custom:omlx', 'ollama', 'custom:ollama', 'splash', 'custom:splash', 'lmstudio', 'custom:lmstudio',
  'llamacpp', 'custom:llamacpp', 'vllm', 'custom:vllm', 'local',
])
const MIGRATED_LIMITS = {
  sambanova: { unit: 'requests', limit: 20, window: 'day-utc' },
  cloudflare: { unit: 'neurons', limit: 10000, window: 'day-utc' },
  'openrouter-free': { unit: 'requests', limit: 1000, window: 'day-utc' },
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function clip(text, max) {
  return String(text || '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max)
}

/** Short error text safe to store. Drops tokens and control characters. */
export function publicError(text) {
  return clip(String(text || '')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/bearer\s+\S+/gi, 'bearer [redacted]')
    .replace(/(api[_-]?key|token|secret|authorization)\s*[:=]\s*\S+/gi, '$1=[redacted]'), 160)
}

export function quotaProviderId(provider, model = '') {
  const name = String(provider || '').toLowerCase()
  const id = String(model || '').toLowerCase()
  if (name === 'openrouter-free') return 'openrouter-free'
  if (name === 'openrouter' && (id.endsWith(':free') || id === 'free' || id.includes(':free'))) return 'openrouter-free'
  if (name === 'kimi' || name === 'kimi-coding' || name === 'moonshot') return 'kimi'
  if (name === 'sambanova' || name === 'custom:sambanova') return 'sambanova'
  if (name === 'cloudflare' || name === 'custom:cloudflare' || name === 'workers-ai' || name === 'workersai' || id.includes('@cf/')) return 'cloudflare'
  if (LOCAL.has(name)) return 'local'
  if (name === 'opencode' || name === 'opencode-go' || name === 'opencode_go') return 'opencode-go'
  const slug = name.replace(/:/g, '-').replace(/[^a-z0-9_-]/g, '').slice(0, 64)
  return ID.test(slug) ? slug : ''
}

const MODEL_KEY = /^[a-z0-9][a-z0-9._:+-]{0,79}$/
/** Retired/removed models: cool down only that model, never the whole provider. */
const MODEL_GONE_TEXT = /end of life|no longer available|model .* gone|\b410\b/i
/** Single-model upstream rate limits (e.g. OpenRouter `:free` upstream congestion). */
const UPSTREAM_MODEL_RATE_TEXT = /temporarily rate-limited upstream/i
/** Per-model caps. A shared window ("weekly", "per day") stays on the provider. */
const MODEL_QUOTA_TEXT = /resource limit exceeded|plan limit|insufficient credits|temporarily rate-limited upstream|end of life|no longer available|model .* gone/i
const QUOTA_TEXT = /429|402|410|quota|rate limit|too many requests|usage limit|resource limit exceeded|plan limit|insufficient credits|weekly|\b7[- ]day\b|end of life|no longer available/i

/** Leaf model id (`cursor/claude-opus-5-5` and `cursor/cursor/claude-opus-5-5` → `claude-opus-5-5`). */
export function modelQuotaId(model) {
  const parts = String(model || '').toLowerCase().split('/').filter(Boolean)
  const leaf = parts.length ? parts[parts.length - 1] : ''
  const slug = leaf.replace(/[^a-z0-9._:+-]/g, '').slice(0, 80)
  return MODEL_KEY.test(slug) ? slug : ''
}

/**
 * Opencodex calls arrive as provider `custom` with model `cursor/<id>`.
 * Those belong on the cursor provider, not on `custom`.
 */
export function quotaTarget(provider, model) {
  let name = String(provider || '').trim()
  const id = String(model || '').trim()
  const lowerModel = id.toLowerCase()
  const lowerName = name.toLowerCase()
  if (lowerModel === 'cursor' || lowerModel.startsWith('cursor/') || lowerModel.includes('/cursor/')) name = 'cursor'
  else if (['custom', 'openai', 'opencode', ''].includes(lowerName) && lowerModel.startsWith('cursor')) name = 'cursor'
  return { provider: name, model: id }
}

/** `model` marks one model. `provider` marks the whole provider. */
export function quotaErrorScope(message) {
  return MODEL_QUOTA_TEXT.test(String(message || '')) ? 'model' : 'provider'
}

function noOpenRouterCredits(table) {
  if (!table || typeof table !== 'object') return false
  if (table.openrouterCredits === false) return true
  const providers = table.providers
  if (!providers || typeof providers !== 'object') return false
  return providers.openrouter?.credits === false || providers['openrouter-free']?.credits === false
}

/**
 * Contract window for one candidate.
 * `dayLimit` is NVIDIA's daily request cap, tracked beside the minute window.
 */
export function limitSpec(table, option) {
  const provider = String(option?.provider || '')
  const model = String(option?.model || '')
  const fullId = option?.fullModel || option?.fullId || (provider && model ? `${provider}/${model}` : provider)
  const id = quotaProviderId(provider, model)
  const source = quotaSource(table, { provider, model, fullModel: fullId })
  const quota = source.quota
  const spec = { id, unit: 'requests', limit: null, window: 'none', dayLimit: null }
  if (!id) return spec
  if (id === 'nvidia') {
    const fromTable = source.source === 'table' && quota?.requests > 0 ? quota.requests : null
    spec.limit = 40
    spec.window = 'minute'
    spec.dayLimit = source.source === 'unlimited' ? null : (fromTable ?? 10000)
    return spec
  }
  if (quota?.neurons > 0 && !(quota.requests > 0)) {
    spec.unit = 'neurons'
    spec.limit = quota.neurons
    spec.window = 'day-utc'
    return spec
  }
  if (quota?.tokens > 0 && !(quota.requests > 0)) {
    spec.unit = 'tokens'
    spec.limit = quota.tokens
    spec.window = 'day-utc'
    return spec
  }
  if (quota?.requests > 0) {
    spec.limit = quota.requests
    spec.window = 'day-utc'
    if (id === 'openrouter-free' && source.source === 'default' && noOpenRouterCredits(table)) spec.limit = 50
    return spec
  }
  if (id === 'kimi' && source.source !== 'unlimited') {
    spec.window = 'week'
    return spec
  }
  if (id === 'openrouter-free' && source.source !== 'unlimited') {
    spec.limit = noOpenRouterCredits(table) ? 50 : 1000
    spec.window = 'day-utc'
  }
  return spec
}

/** Units consumed by one request. `tokensOut` null assumes the routing estimate. */
export function usageDelta(spec, model, tokensIn, tokensOut = null) {
  if (spec?.unit === 'neurons') return chargeFor({ neurons: 1, tokens: 0, requests: 0 }, model, tokensIn, tokensOut).neurons
  if (spec?.unit === 'tokens') return chargeFor({ tokens: 1, neurons: 0, requests: 0 }, model, tokensIn, tokensOut).tokens
  return 1
}

export function windowBounds(window, now) {
  const t = now.getTime()
  if (window === 'minute') {
    const start = new Date(Math.floor(t / 60000) * 60000)
    return { start, reset: new Date(start.getTime() + 60000) }
  }
  if (window === 'day-utc') {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    return { start, reset: new Date(start.getTime() + 86400000) }
  }
  if (window === 'week') {
    const day = now.getUTCDay()
    const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (day === 0 ? 6 : day - 1)))
    return { start: monday, reset: new Date(monday.getTime() + 7 * 86400000) }
  }
  if (window === 'month') {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    return { start, reset: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) }
  }
  return { start: null, reset: null }
}

function laterIso(a, b) {
  const ad = Date.parse(a || '') || 0
  const bd = Date.parse(b || '') || 0
  if (!ad && !bd) return null
  return ad >= bd ? a : b
}

function liveUntil(value, now) {
  const t = Date.parse(value || '')
  if (!Number.isFinite(t) || t <= now.getTime()) return null
  return new Date(t).toISOString()
}

function sameWindow(record, spec, now) {
  if (!record || record.window !== spec.window) return false
  if (spec.window === 'none') return true
  const bounds = windowBounds(spec.window, now)
  return Boolean(bounds.start) && record.windowStart === bounds.start.toISOString()
}

function aligned(record, spec, now) {
  const bounds = windowBounds(spec.window, now)
  const same = sameWindow(record, spec, now)
  const day = utcDay(now)
  return {
    used: same ? num(record?.used) : 0,
    dayUsed: record?.dayStart === day ? num(record.dayUsed) : 0,
    exhaustedUntil: liveUntil(record?.exhaustedUntil, now),
    resetAt: bounds.reset ? bounds.reset.toISOString() : null,
    start: bounds.start ? bounds.start.toISOString() : (record?.windowStart || null),
  }
}

export function providerBlocked(record, spec, delta, now) {
  if (!spec?.id) return false
  const view = aligned(record, spec, now)
  if (view.exhaustedUntil) return true
  if (spec.limit != null && view.used + num(delta) > spec.limit) return true
  if (spec.dayLimit != null && view.dayUsed + 1 > spec.dayLimit) return true
  return false
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return ''
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() !== wanted) continue
    const raw = Array.isArray(value) ? value[0] : value
    return raw == null ? '' : String(raw).trim()
  }
  return ''
}

function headerReset(headers, now) {
  const retry = headerValue(headers, 'retry-after')
  const fromRetry = parseReset(retry, now, false)
  if (fromRetry) return fromRetry
  if (!headers || typeof headers !== 'object') return null
  for (const [key, value] of Object.entries(headers)) {
    const name = String(key).toLowerCase()
    if (!name.startsWith('x-ratelimit-reset')) continue
    const raw = Array.isArray(value) ? value[0] : value
    const parsed = parseReset(raw == null ? '' : String(raw), now, name.endsWith('after') || name.includes('-after'))
    if (parsed) return parsed
  }
  return null
}

function parseReset(raw, now, asDelta) {
  const text = String(raw || '').trim()
  if (!text) return null
  if (/^\d+(\.\d+)?$/.test(text)) {
    const n = Number(text)
    if (!asDelta && n >= 1e12) return new Date(n)
    if (!asDelta && n >= 1e9) return new Date(n * 1000)
    return new Date(now.getTime() + n * 1000)
  }
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? new Date(parsed) : null
}

function isoInText(text, now = null) {
  const match = String(text || '').match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/)
  if (!match) return null
  const parsed = Date.parse(match[0])
  if (!Number.isFinite(parsed)) return null
  // Ignore past timestamps (e.g. an end-of-life date in a 410 message).
  if (now && parsed <= now.getTime()) return null
  return new Date(parsed)
}

export function isQuotaSignal(status, message) {
  const code = Number(status)
  if (code === 429 || code === 402 || code === 410) return true
  // 400/403/500 count only when the body is a quota or retired-model error.
  return QUOTA_TEXT.test(String(message || ''))
}

/** A duration written in the error ("5-hour usage limit"), not a window name like "7-day". */
function durationInText(text, now) {
  const hour = String(text || '').match(/\b(\d+)\s*-?\s*hours?\b/i)
  if (!hour) return null
  const n = Number(hour[1])
  if (!Number.isFinite(n) || n <= 0 || n > 24 * 14) return null
  return new Date(now.getTime() + n * 3600 * 1000)
}

function defaultUntil(spec, status, message, now) {
  const text = String(message || '')
  if (Number(status) === 410 || MODEL_GONE_TEXT.test(text)) {
    return new Date(now.getTime() + MODEL_GONE_EXHAUST_MS)
  }
  if (UPSTREAM_MODEL_RATE_TEXT.test(text)) {
    return new Date(now.getTime() + UPSTREAM_MODEL_RATE_MS)
  }
  const weekly = spec?.window === 'week' || /weekly|\b7[- ]day\b/i.test(text)
  if (weekly && !/retry-after/i.test(text)) {
    const reset = windowBounds('week', now).reset
    if (reset) return reset
  }
  if (spec?.window === 'minute' || /per minute|\brpm\b/i.test(text)) return new Date(now.getTime() + 60 * 1000)
  if (spec?.window === 'day-utc' || spec?.dayLimit != null || /daily|per day/i.test(text) || Number(status) === 402 || /quota/i.test(text)) {
    return windowBounds('day-utc', now).reset
  }
  if (spec?.id === 'cursor') return new Date(now.getTime() + CURSOR_UNKNOWN_EXHAUST_MS)
  return new Date(now.getTime() + 60 * 1000)
}

function signalStatus(status, message) {
  const code = Number(status)
  const text = String(message || '')
  if (code === 402 || /\b402\b/.test(text)) return 402
  if (code === 410 || /\b410\b/.test(text)) return 410
  if (Number.isInteger(code) && code >= 400 && code <= 599) return code
  if (/\b429\b/.test(text)) return 429
  return 429
}

/**
 * When a quota signal exhausts a provider, or one model.
 * `scope` is `model` for a per-model cap (resource limit, plan limit, credits, 410 EOL,
 * upstream single-model rate limit) and `provider` for a shared window.
 * Returns null when the text is not a quota signal.
 * Cursor with no reset time is exhausted for 6 hours, renewed on the next error.
 */
export function exhaustionFromSignal({ status, message, headers, spec, now }) {
  if (!isQuotaSignal(status, message)) return null
  const code = signalStatus(status, message)
  const gone = code === 410 || MODEL_GONE_TEXT.test(String(message || ''))
  const until = headerReset(headers, now) || isoInText(message, now) || durationInText(message, now) || defaultUntil(spec, code, message, now)
  const text = publicError(message) || (code === 402 ? '402' : String(code))
  return { status: code, error: text, exhaustedUntil: until.toISOString(), scope: gone ? 'model' : quotaErrorScope(message) }
}

function blankState(now, host) {
  return {
    version: 1,
    updatedAt: now.toISOString(),
    host,
    providers: {},
    recentPicks: [],
  }
}

function safeId(id) {
  return typeof id === 'string' && ID.test(id) ? id : ''
}

function normalizeRecord(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null
  const unit = row.unit === 'neurons' || row.unit === 'tokens' ? row.unit : 'requests'
  const window = ['day-utc', 'minute', 'week', 'month', 'none'].includes(row.window) ? row.window : 'none'
  const record = {
    unit,
    used: num(row.used),
    limit: row.limit == null || row.limit === '' ? null : (num(row.limit) || null),
    window,
    windowStart: typeof row.windowStart === 'string' ? row.windowStart : null,
    resetAt: typeof row.resetAt === 'string' ? row.resetAt : null,
    exhaustedUntil: typeof row.exhaustedUntil === 'string' ? row.exhaustedUntil : null,
    lastStatus: Number.isInteger(row.lastStatus) ? row.lastStatus : (Number.isFinite(Number(row.lastStatus)) && Number(row.lastStatus) > 0 ? Number(row.lastStatus) : null),
    lastError: row.lastError ? publicError(row.lastError) : null,
    lastUsedAt: typeof row.lastUsedAt === 'string' ? row.lastUsedAt : null,
    requestsTotal: num(row.requestsTotal),
  }
  if (row.dayUsed != null || row.dayLimit != null || row.dayStart) {
    record.dayUsed = num(row.dayUsed)
    record.dayLimit = row.dayLimit == null ? null : (num(row.dayLimit) || null)
    record.dayStart = typeof row.dayStart === 'string' ? row.dayStart : null
  }
  const models = normalizeModels(row.models)
  if (models) record.models = models
  return record
}

function normalizeModel(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null
  const status = Number(row.lastStatus)
  return {
    exhaustedUntil: typeof row.exhaustedUntil === 'string' ? row.exhaustedUntil : null,
    lastStatus: Number.isInteger(status) && status > 0 ? status : null,
    lastError: row.lastError ? publicError(row.lastError) : null,
    lastErrorAt: typeof row.lastErrorAt === 'string' ? row.lastErrorAt : null,
  }
}

function normalizeModels(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const models = {}
  for (const [key, value] of Object.entries(raw)) {
    const id = modelQuotaId(key)
    const model = normalizeModel(value)
    if (id && model) models[id] = model
  }
  return Object.keys(models).length ? models : null
}

function mergeModel(a, b, now) {
  const left = normalizeModel(a)
  const right = normalizeModel(b)
  if (!left) return right
  if (!right) return left
  const ae = Date.parse(left.lastErrorAt || '') || 0
  const be = Date.parse(right.lastErrorAt || '') || 0
  const newer = ae >= be ? left : right
  return {
    exhaustedUntil: liveUntil(laterIso(left.exhaustedUntil, right.exhaustedUntil), now),
    lastStatus: newer.lastStatus ?? null,
    lastError: newer.lastError ?? null,
    lastErrorAt: laterIso(left.lastErrorAt, right.lastErrorAt),
  }
}

function mergeModels(a, b, now) {
  const left = a && typeof a === 'object' && !Array.isArray(a) ? a : {}
  const right = b && typeof b === 'object' && !Array.isArray(b) ? b : {}
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  if (!keys.size) return null
  const models = {}
  for (const key of keys) {
    const id = modelQuotaId(key)
    if (!id) continue
    const merged = mergeModel(left[key] || left[id], right[key] || right[id], now)
    if (merged) models[id] = merged
  }
  return Object.keys(models).length ? models : null
}

function normalizeState(raw, now, host) {
  const providers = {}
  const rows = raw && typeof raw === 'object' ? raw.providers : null
  if (rows && typeof rows === 'object') {
    for (const [key, row] of Object.entries(rows)) {
      const id = safeId(key)
      const record = normalizeRecord(row)
      if (id && record) providers[id] = record
    }
  }
  return {
    version: 1,
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : now.toISOString(),
    host: typeof raw?.host === 'string' && raw.host.trim() ? clip(raw.host, 80) : host,
    providers,
    recentPicks: mergePicks(raw?.recentPicks, []),
  }
}

function dayFields(a, b) {
  const dayA = typeof a?.dayStart === 'string' ? a.dayStart : ''
  const dayB = typeof b?.dayStart === 'string' ? b.dayStart : ''
  const hasA = a?.dayUsed != null || a?.dayLimit != null || dayA
  const hasB = b?.dayUsed != null || b?.dayLimit != null || dayB
  if (!hasA && !hasB) return null
  let dayStart = dayA || dayB || null
  let usedA = a?.dayUsed == null ? null : num(a.dayUsed)
  let usedB = b?.dayUsed == null ? null : num(b.dayUsed)
  if (dayA && dayB && dayA !== dayB) {
    if (dayA > dayB) { dayStart = dayA; usedB = null } else { dayStart = dayB; usedA = null }
  }
  const dayUsed = usedA == null ? (usedB ?? 0) : (usedB == null ? usedA : Math.max(usedA, usedB))
  const dayLimit = a?.dayLimit == null ? (b?.dayLimit ?? null) : (b?.dayLimit == null ? a.dayLimit : a.dayLimit)
  return { dayUsed, dayLimit, dayStart }
}

function mergeProvider(a, b, now) {
  if (!a) return normalizeRecord(b)
  if (!b) return normalizeRecord(a)
  const left = normalizeRecord(a)
  const right = normalizeRecord(b)
  const aw = Date.parse(left.windowStart || '') || 0
  const bw = Date.parse(right.windowStart || '') || 0
  const same = left.window === right.window && (left.window === 'none' || !aw || !bw || aw === bw)
  const newer = aw >= bw ? left : right
  const older = newer === left ? right : left
  const statusFrom = (() => {
    const ae = Date.parse(liveUntil(left.exhaustedUntil, now) || '') || 0
    const be = Date.parse(liveUntil(right.exhaustedUntil, now) || '') || 0
    if (ae !== be) return ae > be ? left : right
    return (Date.parse(left.lastUsedAt || '') || 0) >= (Date.parse(right.lastUsedAt || '') || 0) ? left : right
  })()
  const record = {
    unit: newer.unit || older.unit,
    used: same ? Math.max(left.used, right.used) : newer.used,
    limit: left.limit == null ? right.limit : (right.limit == null ? left.limit : left.limit),
    window: newer.window || older.window,
    windowStart: newer.windowStart || older.windowStart,
    resetAt: newer.resetAt ?? older.resetAt ?? null,
    exhaustedUntil: liveUntil(laterIso(left.exhaustedUntil, right.exhaustedUntil), now),
    lastStatus: statusFrom.lastStatus ?? null,
    lastError: statusFrom.lastError ?? null,
    lastUsedAt: laterIso(left.lastUsedAt, right.lastUsedAt),
    requestsTotal: Math.max(left.requestsTotal, right.requestsTotal),
  }
  const day = dayFields(left, right)
  if (day) Object.assign(record, day)
  const models = mergeModels(left.models, right.models, now)
  if (models) record.models = models
  return record
}

function mergePicks(a, b) {
  const all = [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]
  all.sort((x, y) => (Date.parse(y?.at || '') || 0) - (Date.parse(x?.at || '') || 0))
  const seen = new Set()
  const out = []
  for (const pick of all) {
    if (!pick || typeof pick !== 'object') continue
    const at = typeof pick.at === 'string' ? pick.at : ''
    const model = typeof pick.model === 'string' ? pick.model.slice(0, 200) : ''
    const provider = safeId(String(pick.provider || '').toLowerCase()) || clip(pick.provider, 64)
    if (!at || !model || !provider) continue
    const fallbackFrom = typeof pick.fallbackFrom === 'string' && pick.fallbackFrom ? pick.fallbackFrom.slice(0, 200) : null
    const key = `${at}|${provider}|${model}|${fallbackFrom || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      at,
      mode: pick.mode === 'auto-free' ? 'auto-free' : 'auto',
      model,
      provider,
      label: clip(pick.label, 80),
      reason: publicError(pick.reason),
      fallbackFrom,
    })
    if (out.length >= RECENT_PICKS_MAX) break
  }
  return out
}

function mergeState(a, b, now, host) {
  if (!a) return b ? normalizeState(b, now, host) : blankState(now, host)
  if (!b) return normalizeState(a, now, host)
  const left = normalizeState(a, now, host)
  const right = normalizeState(b, now, host)
  const providers = {}
  for (const key of new Set([...Object.keys(left.providers), ...Object.keys(right.providers)])) {
    providers[key] = mergeProvider(left.providers[key], right.providers[key], now)
  }
  return {
    version: 1,
    updatedAt: laterIso(left.updatedAt, right.updatedAt) || now.toISOString(),
    host: left.host || right.host || host,
    providers,
    recentPicks: mergePicks(left.recentPicks, right.recentPicks),
  }
}

function stampRecord(spec, now, previous) {
  const view = aligned(previous, spec, now)
  const record = {
    unit: spec.unit,
    used: view.used,
    limit: spec.limit,
    window: spec.window,
    windowStart: view.start || now.toISOString(),
    resetAt: view.resetAt,
    exhaustedUntil: view.exhaustedUntil,
    lastStatus: previous?.lastStatus ?? null,
    lastError: previous?.lastError ?? null,
    lastUsedAt: previous?.lastUsedAt ?? null,
    requestsTotal: num(previous?.requestsTotal),
  }
  if (spec.dayLimit != null || previous?.dayUsed != null || previous?.dayLimit != null) {
    record.dayUsed = view.dayUsed
    record.dayLimit = spec.dayLimit
    record.dayStart = utcDay(now)
  }
  if (previous?.models) record.models = { ...previous.models }
  return record
}

function applyUse(state, spec, delta, now, pick) {
  const previous = state.providers[spec.id]
  const record = stampRecord(spec, now, previous)
  record.used = num(record.used) + num(delta)
  record.requestsTotal = num(record.requestsTotal) + 1
  record.lastUsedAt = now.toISOString()
  if (spec.dayLimit != null) record.dayUsed = num(record.dayUsed) + 1
  if (spec.limit != null && record.used >= spec.limit && record.resetAt) {
    record.exhaustedUntil = laterIso(record.exhaustedUntil, record.resetAt)
  }
  if (spec.dayLimit != null && record.dayUsed >= spec.dayLimit) {
    record.exhaustedUntil = laterIso(record.exhaustedUntil, windowBounds('day-utc', now).reset.toISOString())
  }
  state.providers[spec.id] = record
  if (pick) state.recentPicks = mergePicks([pick], state.recentPicks)
  return state
}

function applyError(state, spec, signal, now) {
  const previous = state.providers[spec.id]
  const record = stampRecord(spec, now, previous)
  record.exhaustedUntil = laterIso(record.exhaustedUntil, signal.exhaustedUntil)
  record.lastStatus = signal.status
  record.lastError = signal.error
  record.lastUsedAt = now.toISOString()
  state.providers[spec.id] = record
  return state
}

function applyModelError(state, spec, modelId, signal, now) {
  const previous = state.providers[spec.id]
  const record = stampRecord(spec, now, previous)
  const models = { ...(record.models || {}) }
  const prior = models[modelId]
  models[modelId] = {
    exhaustedUntil: laterIso(prior?.exhaustedUntil, signal.exhaustedUntil) || signal.exhaustedUntil,
    lastStatus: signal.status,
    lastError: signal.error,
    lastErrorAt: now.toISOString(),
  }
  record.models = models
  state.providers[spec.id] = record
  return state
}

function modelExhausted(record, model, now) {
  const id = modelQuotaId(model)
  if (!id || !record?.models) return null
  const until = liveUntil(record.models[id]?.exhaustedUntil, now)
  return until ? { model: id, until } : null
}

function samePickModel(pickModel, full, model) {
  if (!pickModel) return false
  if (pickModel === full || pickModel === model) return true
  return Boolean(model && pickModel.endsWith(`/${model}`))
}

/** True when Auto already reserved this provider/model a moment before the call started. */
function reservedRecently(state, spec, opts) {
  const started = Date.parse(opts?.startedAt || '')
  if (!Number.isFinite(started)) return false
  const full = clip(opts.fullId || `${opts.provider}/${opts.model}`, 200)
  const model = clip(opts.model, 200)
  for (const pick of state?.recentPicks || []) {
    if (!pick || pick.provider !== spec.id || !samePickModel(pick.model, full, model)) continue
    const at = Date.parse(pick.at || '')
    if (!Number.isFinite(at)) continue
    const delta = started - at
    if (delta >= -2000 && delta <= RESERVE_MATCH_MS) return true
  }
  return false
}

function pickFrom(opts, spec, now) {
  return {
    at: now.toISOString(),
    mode: opts.mode === 'auto-free' ? 'auto-free' : 'auto',
    model: clip(opts.fullId || `${opts.provider}/${opts.model}`, 200),
    provider: spec.id,
    label: clip(opts.label, 80),
    reason: publicError(opts.reason),
    fallbackFrom: opts.fallbackFrom ? clip(opts.fallbackFrom, 200) : null,
  }
}

async function migrateDaily(dir, now) {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'daily-quota.json'), 'utf8'))
    const today = utcDay(now)
    const providers = {}
    const days = raw?.days && typeof raw.days === 'object' ? raw.days : {}
    for (const [scope, row] of Object.entries(days)) {
      const id = safeId(scope)
      if (!id || !row || row.utcDay !== today) continue
      const neurons = num(row.neurons)
      const requests = num(row.requests)
      const known = MIGRATED_LIMITS[id]
      const unit = neurons > 0 && requests === 0 ? 'neurons' : (known?.unit || 'requests')
      const used = unit === 'neurons' ? neurons : requests
      const window = known?.window || 'day-utc'
      const bounds = windowBounds(window, now)
      providers[id] = {
        unit,
        used,
        limit: known?.limit ?? null,
        window,
        windowStart: bounds.start.toISOString(),
        resetAt: bounds.reset.toISOString(),
        exhaustedUntil: null,
        lastStatus: null,
        lastError: null,
        lastUsedAt: null,
        requestsTotal: requests,
      }
    }
    return providers
  } catch {
    return {}
  }
}

export function createProviderQuotaStore(dir, { now = () => new Date(), host = '' } = {}) {
  const file = path.join(dir, PROVIDER_QUOTA_FILE)
  const proFile = path.join(dir, PROVIDER_QUOTA_PRO_FILE)
  const hostName = clip(host || os.hostname() || 'unknown', 80) || 'unknown'
  let chain = Promise.resolve()
  let memory = null
  let persisted = false

  function enqueue(fn) {
    const run = chain.then(fn, fn)
    chain = run.then(() => {}, () => {})
    return run
  }

  async function readJson(target) {
    try {
      return JSON.parse(await fs.readFile(target, 'utf8'))
    } catch {
      return null
    }
  }

  async function readLocal() {
    const clock = now()
    const raw = await readJson(file)
    if (raw) {
      persisted = true
      return normalizeState(raw, clock, hostName)
    }
    const providers = await migrateDaily(dir, clock)
    return { ...blankState(clock, hostName), providers }
  }

  async function readPro() {
    const raw = await readJson(proFile)
    if (!raw) return null
    return normalizeState(raw, now(), hostName)
  }

  async function write(state) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    const tmp = path.join(dir, `.provider-quota.${process.pid}.${Date.now()}.tmp`)
    const body = JSON.stringify(state)
    await fs.writeFile(tmp, body, { mode: 0o600 })
    await fs.rename(tmp, file)
    await fs.chmod(file, 0o600).catch(() => {})
    persisted = true
  }

  async function loadMerged() {
    const clock = now()
    const disk = await readLocal()
    return mergeState(memory, disk, clock, hostName)
  }

  async function persist(state) {
    const clock = now()
    if (!persisted) {
      const again = await readJson(file)
      if (again) {
        persisted = true
        return mergeState(state, again, clock, hostName)
      }
    } else {
      const again = await readJson(file)
      if (again) return mergeState(state, again, clock, hostName)
    }
    return state
  }

  function specOf(table, opts) {
    return limitSpec(table, {
      provider: opts.provider,
      model: opts.model,
      fullModel: opts.fullId,
    })
  }

  return {
    file,
    proFile,
    snapshot() {
      return enqueue(async () => {
        const local = await loadMerged()
        const clock = now()
        local.updatedAt = clock.toISOString()
        local.host = hostName
        const written = await persist(local)
        if (!persisted || written !== local) await write(written)
        else if (!(await readJson(file))) await write(written)
        memory = written
        return { local: written, pro: await readPro() }
      })
    },
    blockDetail(view, table, option, tokensIn) {
      const spec = limitSpec(table, option)
      if (!spec.id) return null
      const delta = usageDelta(spec, option?.model, tokensIn, null)
      const clock = now()
      const model = option?.model || option?.fullModel || ''
      for (const record of [view?.local?.providers?.[spec.id], view?.pro?.providers?.[spec.id]]) {
        if (providerBlocked(record, spec, delta, clock)) {
          const viewRow = aligned(record, spec, clock)
          return {
            scope: 'provider',
            provider: spec.id,
            model: modelQuotaId(model),
            until: viewRow.exhaustedUntil || (spec.limit != null || spec.dayLimit != null ? viewRow.resetAt : null),
          }
        }
        const hit = modelExhausted(record, model, clock)
        if (hit) return { scope: 'model', provider: spec.id, model: hit.model, until: hit.until }
      }
      return null
    },
    blocked(view, table, option, tokensIn) {
      return Boolean(this.blockDetail(view, table, option, tokensIn))
    },
    reserve(opts) {
      return enqueue(async () => {
        const clock = now()
        const base = await loadMerged()
        const spec = specOf(opts.table, opts)
        if (!spec.id) return false
        const delta = usageDelta(spec, opts.model, opts.tokensIn, opts.tokensOut ?? null)
        const pro = await readPro()
        const model = opts.model || opts.fullId
        if (providerBlocked(base.providers[spec.id], spec, delta, clock) || providerBlocked(pro?.providers?.[spec.id], spec, delta, clock)
          || modelExhausted(base.providers[spec.id], model, clock) || modelExhausted(pro?.providers?.[spec.id], model, clock)) {
          memory = base
          return false
        }
        const draft = structuredClone(base)
        applyUse(draft, spec, delta, clock, pickFrom(opts, spec, clock))
        const merged = await persist(draft)
        merged.version = 1
        merged.updatedAt = clock.toISOString()
        merged.host = hostName
        await write(merged)
        memory = merged
        return true
      })
    },
    /** A request that already ran (a fallback). Counted even when it crosses the cap. */
    recordUse(opts) {
      return enqueue(async () => {
        const clock = now()
        const base = await loadMerged()
        const spec = specOf(opts.table, opts)
        if (!spec.id) return false
        if (reservedRecently(base, spec, opts)) {
          memory = base
          return 'reserved'
        }
        const delta = usageDelta(spec, opts.model, opts.tokensIn, opts.tokensOut ?? null)
        const draft = structuredClone(base)
        applyUse(draft, spec, delta, clock, opts.pick === false ? null : pickFrom(opts, spec, clock))
        const merged = await persist(draft)
        merged.version = 1
        merged.updatedAt = clock.toISOString()
        merged.host = hostName
        await write(merged)
        memory = merged
        return true
      })
    },
    noteErrors({ table, errors }) {
      return enqueue(async () => {
        const list = Array.isArray(errors) ? errors.slice(0, 8) : []
        if (!list.length) return false
        const clock = now()
        const base = await loadMerged()
        const draft = structuredClone(base)
        let changed = false
        for (const hint of list) {
          let provider = String(hint?.provider || '')
          let model = String(hint?.model || '')
          if (model.includes('/') && (!provider || model.startsWith(`${provider}/`))) {
            if (!provider) provider = model.slice(0, model.indexOf('/'))
            if (model.startsWith(`${provider}/`)) model = model.slice(provider.length + 1)
          }
          const targeted = quotaTarget(provider, model)
          provider = targeted.provider
          model = targeted.model
          const fullModel = hint?.model && String(hint.model).includes('/') ? String(hint.model) : ''
          const spec = limitSpec(table, { provider, model, fullModel })
          if (!spec.id) continue
          const signal = exhaustionFromSignal({
            status: hint?.status,
            message: hint?.message,
            headers: hint?.headers,
            spec,
            now: clock,
          })
          if (!signal) continue
          const modelId = modelQuotaId(model)
          if (signal.scope === 'model' && modelId) applyModelError(draft, spec, modelId, signal, clock)
          else applyError(draft, spec, signal, clock)
          changed = true
        }
        if (!changed) {
          memory = base
          return false
        }
        const merged = await persist(draft)
        merged.version = 1
        merged.updatedAt = clock.toISOString()
        merged.host = hostName
        await write(merged)
        memory = merged
        return true
      })
    },
  }
}
