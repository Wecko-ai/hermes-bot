import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Daily free-tier quotas for Auto.
 *
 * Table shape (any of these, first match wins per model):
 * - `models[<provider/model>].dailyQuota`: `{ requests?, tokens?, neurons?, scope?, reset? }`
 *   A number is a request cap. `reset` is informational; the counter always rolls at 00:00 UTC.
 *   An explicit empty object means no cap (the built-in default is not applied).
 * - `providers[<provider>].dailyQuota` or `dailyQuotas[<provider>]` when the model entry omits the field.
 * - Built-in defaults when the table says nothing: SambaNova 20 requests/day,
 *   Cloudflare Workers AI 10_000 neurons/day, OpenRouter `:free` 1_000 requests/day.
 *   NVIDIA and local servers have no default daily cap here (ranking stays generous).
 *   The shared contract file tracks NVIDIA's 40/minute and ~10_000/day separately.
 *
 * Cloudflare neurons (Workers AI pricing, read 2026-11-23):
 * - `@cf/meta/llama-3.1-8b-instruct-fp8-fast`: 4_119 neurons / 1M input tokens, 34_868 / 1M output.
 * - `@cf/meta/llama-3.3-70b-instruct-fp8-fast`: 26_668 / 1M input, 204_805 / 1M output
 *   (same public pricing table; third-party copies of that row agree).
 * Routing does not know the reply length, so a charge assumes 400 output tokens
 * (`ASSUMED_OUTPUT_TOKENS`) plus the prompt token estimate. Unknown Cloudflare models
 * use the 70B rates when tokens are known, otherwise a flat 80 neurons
 * (`CLOUDFLARE_NEURONS_PER_REQUEST`): a 1_000-in/400-out turn is ~18 neurons on the 8B
 * fp8-fast model and ~109 on the 70B, and 80 sits between them (~125 requests inside
 * the 10_000 neuron daily pool).
 *
 * Caps under 200 request-equivalents (SambaNova's 20, Cloudflare's ~125) are a tiny
 * tier and sort after uncapped free models (NVIDIA, local) and after larger caps
 * (OpenRouter's 1_000). Usage is one JSON file in the auto-router state directory.
 */

export const ASSUMED_OUTPUT_TOKENS = 400
export const CLOUDFLARE_NEURONS_PER_REQUEST = 80
export const TINY_DAILY_REQUESTS = 200

const SCOPE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

const CF_RATES = {
  'llama-3.1-8b-instruct-fp8-fast': { in: 4119, out: 34868 },
  'llama-3.3-70b-instruct-fp8-fast': { in: 26668, out: 204805 },
}
const CF_UNKNOWN_RATES = CF_RATES['llama-3.3-70b-instruct-fp8-fast']

const LOCAL_PROVIDERS = new Set(['omlx', 'custom:omlx', 'ollama', 'custom:ollama', 'splash', 'custom:splash', 'lmstudio', 'custom:lmstudio', 'llamacpp', 'custom:llamacpp', 'vllm', 'custom:vllm', 'local'])

function positive(value) {
  const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() ? Number(value) : NaN)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function nonNeg(value) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10)
}

export function parseDailyQuota(value) {
  if (typeof value === 'number' || (typeof value === 'string' && value.trim())) {
    const requests = positive(value)
    return requests
      ? { requests, tokens: 0, neurons: 0, scope: '', unlimited: false }
      : { requests: 0, tokens: 0, neurons: 0, scope: '', unlimited: true }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const hasLimitKey = ['requests', 'tokens', 'neurons'].some((key) => Object.prototype.hasOwnProperty.call(value, key))
  const requests = positive(value.requests)
  const tokens = positive(value.tokens)
  const neurons = positive(value.neurons)
  const scope = typeof value.scope === 'string' && SCOPE.test(value.scope) ? value.scope : ''
  if (!requests && !tokens && !neurons) {
    if (!hasLimitKey) return null
    return { requests: 0, tokens: 0, neurons: 0, scope, unlimited: true }
  }
  return { requests, tokens, neurons, scope, unlimited: false }
}

function lookupEntry(table, fullId) {
  const models = table?.models
  if (!models || typeof models !== 'object') return null
  const id = String(fullId || '')
  if (models[id] && typeof models[id] === 'object') return models[id]
  const bare = id.startsWith('custom:') ? id.slice(7) : ''
  if (bare && models[bare] && typeof models[bare] === 'object') return models[bare]
  const short = id.split('/').pop()
  if (short && models[short] && typeof models[short] === 'object') return models[short]
  return null
}

/** undefined = not a usable cap (absent or incomplete); null = explicit unlimited. */
function interpretedQuota(value) {
  const parsed = parseDailyQuota(value)
  if (!parsed) return undefined
  if (parsed.unlimited) return null
  return parsed
}

/** undefined = provider not listed; null = listed but uncapped. */
function mapQuota(table, provider) {
  const providers = table?.providers
  if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
    const row = providers[provider]
    if (row && typeof row === 'object') {
      if (Object.prototype.hasOwnProperty.call(row, 'dailyQuota')) {
        const parsed = interpretedQuota(row.dailyQuota)
        if (parsed !== undefined) return parsed
      } else if (row.requests != null || row.tokens != null || row.neurons != null) {
        const parsed = interpretedQuota(row)
        if (parsed !== undefined) return parsed
      }
    }
  }
  for (const key of ['dailyQuotas', 'providerQuotas']) {
    const map = table?.[key]
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue
    if (map.requests != null || map.neurons != null || map.tokens != null || map.dailyQuota != null) continue
    if (Object.prototype.hasOwnProperty.call(map, provider)) {
      const parsed = interpretedQuota(map[provider])
      if (parsed !== undefined) return parsed
    }
  }
  return undefined
}

function isOpenRouterFree(model) {
  const lower = String(model || '').toLowerCase()
  return lower.endsWith(':free') || lower === 'openrouter/free'
}

function isCloudflare(provider, model, fullId) {
  if (provider === 'cloudflare' || provider === 'custom:cloudflare' || provider === 'workers-ai' || provider === 'workersai') return true
  return `${fullId}\n${model}`.toLowerCase().includes('@cf/')
}

function defaultQuota(provider, model, fullId) {
  if (provider === 'nvidia' || LOCAL_PROVIDERS.has(provider)) return null
  if (provider === 'sambanova' || provider === 'custom:sambanova') return { requests: 20, tokens: 0, neurons: 0, scope: 'sambanova', unlimited: false }
  if (provider === 'openrouter' && isOpenRouterFree(model)) return { requests: 1000, tokens: 0, neurons: 0, scope: 'openrouter-free', unlimited: false }
  if (isCloudflare(provider, model, fullId)) return { requests: 0, tokens: 0, neurons: 10000, scope: 'cloudflare', unlimited: false }
  return null
}

function finish(parsed, provider, model) {
  if (!parsed || parsed.unlimited) return null
  const fallback = provider === 'openrouter' && isOpenRouterFree(model) ? 'openrouter-free' : provider
  const scope = parsed.scope || fallback
  if (!SCOPE.test(scope)) return null
  return { requests: parsed.requests, tokens: parsed.tokens, neurons: parsed.neurons, scope }
}

/**
 * Where a model's daily cap came from.
 * `unlimited` is an explicit empty cap, `table` is a number from the table,
 * `default` is a built-in, `none` means the table and the defaults are silent.
 */
export function quotaSource(table, option) {
  const provider = String(option?.provider || '').toLowerCase()
  const model = String(option?.model || '')
  const fullId = option?.fullModel || option?.fullId || `${option?.provider || ''}/${option?.model || ''}`
  const entry = lookupEntry(table, fullId)
  if (entry && Object.prototype.hasOwnProperty.call(entry, 'dailyQuota')) {
    const parsed = parseDailyQuota(entry.dailyQuota)
    if (parsed?.unlimited) return { source: 'unlimited', quota: null }
    if (parsed) return { source: 'table', quota: finish(parsed, provider, model) }
  }
  const fromProvider = mapQuota(table, provider)
  if (fromProvider === null) return { source: 'unlimited', quota: null }
  if (fromProvider) return { source: 'table', quota: finish(fromProvider, provider, model) }
  const fallback = defaultQuota(provider, model, fullId)
  if (fallback) return { source: 'default', quota: finish(fallback, provider, model) }
  return { source: 'none', quota: null }
}

/** Resolved cap for one candidate, or null when the model is uncapped. */
export function resolveDailyQuota(table, option) {
  return quotaSource(table, option).quota
}

/**
 * Neurons for one Cloudflare request.
 * Missing token counts use the flat per-request estimate.
 */
export function cloudflareNeurons(model, tokensIn, tokensOut) {
  const id = String(model || '')
  const known = Object.entries(CF_RATES).find(([key]) => id.includes(key))
  const inn = Math.max(0, Number(tokensIn) || 0)
  const out = Math.max(0, Number(tokensOut) || 0)
  if (inn === 0 && out === 0) return CLOUDFLARE_NEURONS_PER_REQUEST
  const rates = known ? known[1] : CF_UNKNOWN_RATES
  return Math.round(((inn * rates.in + out * rates.out) / 1_000_000) * 1000) / 1000
}

/** What one routed request consumes. Output length is assumed when the reply is not known yet. */
export function chargeFor(quota, model, tokensIn, tokensOut = null) {
  const inn = Math.max(0, Number(tokensIn) || 0)
  const out = tokensOut == null ? ASSUMED_OUTPUT_TOKENS : Math.max(0, Number(tokensOut) || 0)
  const delta = { requests: 1, tokens: 0, neurons: 0 }
  if (quota?.tokens > 0) delta.tokens = inn + out
  if (quota?.neurons > 0) delta.neurons = (inn === 0 && out === 0) ? CLOUDFLARE_NEURONS_PER_REQUEST : cloudflareNeurons(model, inn, out)
  return delta
}

export function isQuotaExhausted(quota, usage, delta = { requests: 1, tokens: 0, neurons: 0 }) {
  if (!quota) return false
  const requests = nonNeg(usage?.requests)
  const tokens = nonNeg(usage?.tokens)
  const neurons = nonNeg(usage?.neurons)
  if (quota.requests > 0 && requests + nonNeg(delta.requests) > quota.requests) return true
  if (quota.tokens > 0 && tokens + nonNeg(delta.tokens) > quota.tokens) return true
  if (quota.neurons > 0 && neurons + nonNeg(delta.neurons) > quota.neurons) return true
  return false
}

/** Request-equivalents of a cap. Neurons use the flat per-request estimate. */
export function requestBudget(quota) {
  if (!quota) return Number.POSITIVE_INFINITY
  const caps = []
  if (quota.requests > 0) caps.push(quota.requests)
  if (quota.neurons > 0) caps.push(quota.neurons / CLOUDFLARE_NEURONS_PER_REQUEST)
  if (!caps.length && quota.tokens > 0) caps.push(quota.tokens / 2000)
  if (!caps.length) return Number.POSITIVE_INFINITY
  return Math.min(...caps)
}

/** 0 = uncapped (NVIDIA, local), 1 = a large daily cap, 2 = a tiny cap. */
export function freeTier(quota) {
  const budget = requestBudget(quota)
  if (!quota || !Number.isFinite(budget)) return { tier: 0, budget: Number.POSITIVE_INFINITY }
  return { tier: budget < TINY_DAILY_REQUESTS ? 2 : 1, budget }
}

/** Uncapped free models first, then larger daily caps, then tiny caps. Score breaks ties inside a tier. */
export function rankFreeCandidates(scored, quotaOf) {
  return scored
    .map((row, index) => ({ row, index, ...freeTier(quotaOf(row)) }))
    .sort((a, b) => a.tier - b.tier || b.row.score - a.row.score || b.budget - a.budget || a.index - b.index)
    .map((item) => item.row)
}

export function freePickReason(picked, ranked, quotaOf) {
  const best = [...ranked].sort((a, b) => b.score - a.score)[0]
  if (!best || best.fullId === picked.chosen) return picked.reason
  const chosenTier = freeTier(quotaOf({ provider: picked.provider, model: picked.model, fullId: picked.chosen })).tier
  const bestTier = freeTier(quotaOf(best)).tier
  if (chosenTier < bestTier) {
    const scope = quotaOf(best)?.scope || best.provider
    const kind = bestTier >= 2 ? 'tiny daily quota' : 'capped daily quota'
    return `${picked.chosen} before ${kind} ${scope} (${best.fullId})`
  }
  return picked.reason
}

function blankUsage(day) {
  return { utcDay: day, requests: 0, tokens: 0, neurons: 0 }
}

function normalizeState(raw, today) {
  const days = raw && typeof raw === 'object' && raw.days && typeof raw.days === 'object' ? raw.days : {}
  const state = {}
  for (const [scope, row] of Object.entries(days)) {
    if (!SCOPE.test(scope) || !row || typeof row !== 'object') continue
    if (row.utcDay !== today) continue
    state[scope] = {
      utcDay: today,
      requests: nonNeg(row.requests),
      tokens: nonNeg(row.tokens),
      neurons: nonNeg(row.neurons),
    }
  }
  return state
}

/**
 * Persistent per-scope counters in `<stateDir>/daily-quota.json`.
 * Each scope resets on its own when the UTC day changes.
 */
export function createDailyQuotaStore(dir, { now = () => new Date() } = {}) {
  const file = path.join(dir, 'daily-quota.json')
  let chain = Promise.resolve()
  let memory = null

  function enqueue(fn) {
    const run = chain.then(fn, fn)
    chain = run.then(() => {}, () => {})
    return run
  }

  async function load() {
    const today = utcDay(now())
    if (memory) {
      for (const key of Object.keys(memory)) {
        if (memory[key].utcDay !== today) delete memory[key]
      }
      return memory
    }
    try {
      memory = normalizeState(JSON.parse(await fs.readFile(file, 'utf8')), today)
    } catch {
      memory = {}
    }
    return memory
  }

  async function save(state) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    const tmp = path.join(dir, `.daily-quota.${process.pid}.tmp`)
    await fs.writeFile(tmp, JSON.stringify({ v: 1, days: state }), { mode: 0o600 })
    await fs.rename(tmp, file)
    await fs.chmod(file, 0o600).catch(() => {})
  }

  return {
    file,
    snapshot() {
      return enqueue(async () => {
        const state = await load()
        const view = {}
        for (const [scope, row] of Object.entries(state)) {
          view[scope] = { requests: row.requests, tokens: row.tokens, neurons: row.neurons }
        }
        return view
      })
    },
    tryConsume(scope, delta, quota) {
      return enqueue(async () => {
        if (!SCOPE.test(scope) || !quota) return false
        const state = await load()
        const today = utcDay(now())
        const row = state[scope] && state[scope].utcDay === today ? state[scope] : blankUsage(today)
        const usage = { requests: row.requests, tokens: row.tokens, neurons: row.neurons }
        if (isQuotaExhausted(quota, usage, delta)) return false
        const previous = state[scope]
        state[scope] = {
          utcDay: today,
          requests: row.requests + nonNeg(delta.requests),
          tokens: row.tokens + nonNeg(delta.tokens),
          neurons: row.neurons + nonNeg(delta.neurons),
        }
        memory = state
        try {
          await save(state)
        } catch (error) {
          if (previous) state[scope] = previous
          else delete state[scope]
          throw error
        }
        return true
      })
    },
    /** Counts a request that already happened (a fallback), even if it crosses the cap. */
    record(scope, delta) {
      return enqueue(async () => {
        if (!SCOPE.test(scope)) return false
        const state = await load()
        const today = utcDay(now())
        const row = state[scope] && state[scope].utcDay === today ? state[scope] : blankUsage(today)
        state[scope] = {
          utcDay: today,
          requests: row.requests + nonNeg(delta.requests),
          tokens: row.tokens + nonNeg(delta.tokens),
          neurons: row.neurons + nonNeg(delta.neurons),
        }
        memory = state
        await save(state)
        return true
      })
    },
  }
}
