import fs from 'node:fs/promises'
import { isSafeModelId } from '../model-id.mjs'

function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function modelKey(provider, model) {
  return `${provider}/${model}`
}

function tableQuality(table, fullId, category) {
  const entry = tableEntry(table, fullId)
  if (!entry || !entry.quality) return 0.5
  return asNumber(entry.quality[category]) || 0.5
}

export function tableEntry(table, fullId) {
  const id = String(fullId || '')
  const bare = id.startsWith('custom:') ? id.slice(7) : ''
  return table?.models?.[id]
    || (bare ? table?.models?.[bare] : null)
    || table?.models?.[id.split('/').slice(-1)[0]]
    || null
}

function tableCost(table, fullId) {
  const entry = tableEntry(table, fullId)
  if (!entry) return 0
  const cost = entry.costPerMToken && typeof entry.costPerMToken === 'object' ? entry.costPerMToken : {}
  return asNumber(cost.in) + asNumber(cost.out)
}

/** USD estimate from the scoring table (per-million token rates; 0 for flat subscriptions). */
export function estimateTokenCost(table, fullId, tokensIn, tokensOut) {
  const entry = tableEntry(table, fullId)
  if (!entry) return 0
  const cost = entry.costPerMToken && typeof entry.costPerMToken === 'object' ? entry.costPerMToken : {}
  const inn = Math.max(0, asNumber(tokensIn))
  const out = Math.max(0, asNumber(tokensOut))
  const usd = (inn * asNumber(cost.in) + out * asNumber(cost.out)) / 1_000_000
  return Math.round(usd * 1_000_000) / 1_000_000
}

function quotaPercentFor(fullId, quotaPercents) {
  let best = 0
  for (const [prefix, percent] of quotaPercents) {
    if (fullId.startsWith(prefix) || fullId.includes(`/${prefix}`) || fullId.startsWith(`${prefix}/`)) {
      best = Math.max(best, percent)
    }
  }
  return best
}

function tableBaselineLatency(table, fullId) {
  const entry = tableEntry(table, fullId)
  return asNumber(entry?.baselineLatencyMs) || 2000
}

/**
 * @param {{ provider: string, model: string, free?: boolean }} option
 * @param {{ zeroSpend?: boolean, subscriptionProviders?: string[], isFreeModel?: (o: object) => boolean, isPaidBlocked?: (o: object) => boolean }} policy
 */
export function allowedForSpend(option, policy) {
  const zeroSpend = policy.zeroSpend === true
  if (!zeroSpend) return true
  if (policy.isPaidBlocked?.(option)) return false
  if (policy.isFreeModel?.(option)) return true
  const subs = new Set(policy.subscriptionProviders || [])
  return subs.has(option.provider)
}

/**
 * @param {{ table: object, category: string, candidates: object[], latencyMs?: Map<string, number>, quotaPercents?: Map<string, number>, weights?: object }} params
 */
export function scoreCandidates(params) {
  const { table, category, candidates } = params
  const weights = { quality: 1, cost: 0.25, quota: 0.35, latency: 0.15, context: 0.3, ...(table?.weights || {}), ...(params.weights || {}) }
  // A long conversation: the bigger the window the better, and slow past turns say nothing (long turns are slow).
  const longContext = category === 'long_context'
  const latencyMs = params.latencyMs || new Map()
  const quotaPercents = params.quotaPercents || new Map()

  return candidates.map((raw) => {
    const provider = String(raw.provider || '')
    const model = String(raw.model || '')
    const fullId = raw.fullModel || modelKey(provider, model)
    const quality = tableQuality(table, fullId, category)
    const cost = tableCost(table, fullId)
    const costNorm = cost <= 0 ? 1 : Math.max(0, 1 - Math.min(cost, 10) / 10)
    let quotaHeadroom = 1
    for (const [prefix, percent] of quotaPercents) {
      if (fullId.startsWith(prefix) || fullId.includes(`/${prefix}`)) {
        quotaHeadroom = Math.max(0, 1 - percent / 100)
        break
      }
    }
    const observed = latencyMs.get(fullId)
    const baseline = tableBaselineLatency(table, fullId)
    const lat = observed || baseline
    const latencyNorm = Math.max(0, 1 - Math.min(lat, 30_000) / 30_000)
    const window = typeof raw.contextWindow === 'number' ? raw.contextWindow : 0
    const contextNorm = Math.min(1, window / 1_000_000)
    const score = (weights.quality * quality)
      + (weights.cost * costNorm)
      + (weights.quota * quotaHeadroom)
      + (longContext ? weights.context * contextNorm : weights.latency * latencyNorm)
    return {
      provider,
      model,
      fullId,
      score: Math.round(score * 1000) / 1000,
      quality,
      contextWindow: window,
      reasonParts: { quality, costNorm, quotaHeadroom, latencyNorm, contextNorm },
    }
  }).sort((a, b) => b.score - a.score)
}

function selectFallbacks(ranked, table = null, count = 2) {
  const rest = ranked.slice(1)
  if (!rest.length || count <= 0) return []
  const top = ranked[0]
  const chosen = []
  const usedIds = new Set([top.fullId])
  const usedProviders = new Set([top.provider])

  const take = (row) => {
    if (!row || usedIds.has(row.fullId)) return false
    chosen.push(row)
    usedIds.add(row.fullId)
    if (row.provider) usedProviders.add(row.provider)
    return true
  }

  // First fallback: prefer a different provider so a provider-wide outage does not fail twice in a row.
  const firstDistinct = rest.find((row) => row.provider !== top.provider)
  take(firstDistinct || rest[0])

  // Second fallback: when neither the pick nor the first fallback is strictly free, reserve a slot for
  // the best strictly free candidate so exhausted subscriptions still land on a free model.
  if (chosen.length < count) {
    const hasFree = isStrictlyFree(top, table) || chosen.some((row) => isStrictlyFree(row, table))
    if (!hasFree) {
      const freeDistinct = rest.find((row) => !usedIds.has(row.fullId) && !usedProviders.has(row.provider) && isStrictlyFree(row, table))
      const freeAny = freeDistinct || rest.find((row) => !usedIds.has(row.fullId) && isStrictlyFree(row, table))
      take(freeAny)
    }
  }
  while (chosen.length < count) {
    const distinct = rest.find((row) => !usedIds.has(row.fullId) && !usedProviders.has(row.provider))
    const next = distinct || rest.find((row) => !usedIds.has(row.fullId))
    if (!take(next)) break
  }
  return chosen
}

export function pickModel(scored, { blocked = new Set(), quotaPercents = new Map(), quotaHighWatermark = 85, table = null } = {}) {
  const ranked = scored.filter((row) => !blocked.has(row.fullId))
  if (!ranked.length) return null
  const top = ranked[0]
  const qualityPick = [...ranked].sort((a, b) => b.quality - a.quality)[0]
  let reason = `Best ${top.reasonParts.quality.toFixed(2)} quality for category, quota headroom ${Math.round(top.reasonParts.quotaHeadroom * 100)}%`
  if (qualityPick && qualityPick.fullId !== top.fullId) {
    const pct = Math.round(quotaPercentFor(qualityPick.fullId, quotaPercents))
    if (pct >= quotaHighWatermark) {
      const label = qualityPick.fullId.split('/')[0] || qualityPick.fullId
      reason = `${label} quota ${pct}% -> ${top.fullId}`
    }
  }
  return {
    chosen: top.fullId,
    provider: top.provider,
    model: top.model,
    reason,
    candidates: ranked.slice(0, 8).map((row) => ({ model: row.fullId, score: row.score })),
    fallbacks: selectFallbacks(ranked, table, 2),
  }
}

export async function loadScoringTable(tablePath) {
  const raw = JSON.parse(await fs.readFile(tablePath, 'utf8'))
  if (!raw || typeof raw !== 'object') throw new Error('invalid_table')
  return raw
}

const LOCAL_PROVIDERS = new Set(['omlx', 'custom:omlx', 'ollama', 'custom:ollama', 'lmstudio', 'custom:lmstudio', 'llamacpp', 'custom:llamacpp', 'vllm', 'custom:vllm', 'local'])

function isCloudflareId(provider, model, fullId) {
  if (provider === 'cloudflare' || provider === 'custom:cloudflare' || provider === 'workers-ai' || provider === 'workersai') return true
  return `${fullId}\n${model}`.includes('@cf/')
}

/**
 * "Auto gratuit": models that cost nothing and use no subscription quota.
 * NVIDIA's free catalog, servers on this Mac, OpenRouter `:free` variants, SambaNova and
 * Cloudflare Workers AI (`@cf/…` ids). A table cost above zero keeps a model out
 * (a billed row at one of these providers). Missing rows count as zero.
 * Subscriptions (Kimi, Cursor, OpenCode Go) and Gemini stay out.
 */
export function isStrictlyFree(option, table = null) {
  const provider = String(option?.provider || '').toLowerCase()
  const model = String(option?.model || '').toLowerCase()
  const fullId = String(option?.fullModel || option?.fullId || `${option?.provider || ''}/${option?.model || ''}`)
  const openrouterFree = provider === 'openrouter' && (model.endsWith(':free') || model === 'openrouter/free')
  const eligible = provider === 'nvidia'
    || provider === 'sambanova'
    || provider === 'custom:sambanova'
    || LOCAL_PROVIDERS.has(provider)
    || openrouterFree
    || isCloudflareId(provider, model, fullId.toLowerCase())
  if (!eligible) return false
  if (table && tableCost(table, fullId) > 0) return false
  return true
}

/**
 * Default Auto candidates per provider: via Cursor only Composer and Grok, never Claude,
 * GPT or Gemini (their Cursor quota runs out). A table `candidateAllow` replaces the default;
 * `{}` lifts every rule. Matching is a case-insensitive substring of the model id.
 */
export const DEFAULT_CANDIDATE_ALLOW = Object.freeze({ cursor: Object.freeze(['composer', 'grok']) })

export function allowedByCandidateRules(option, table = null) {
  const rules = table && typeof table.candidateAllow === 'object' && table.candidateAllow !== null
    ? table.candidateAllow
    : DEFAULT_CANDIDATE_ALLOW
  const allow = rules[String(option?.provider || '').toLowerCase()]
  if (!Array.isArray(allow)) return true
  const model = String(option?.model || '').toLowerCase()
  return allow.some((part) => typeof part === 'string' && part !== '' && model.includes(part.toLowerCase()))
}

export function normalizeCandidate(option) {
  const provider = String(option.provider || '')
  const model = String(option.model || '')
  const fullModel = option.fullModel || modelKey(provider, model)
  if (!isSafeModelId(fullModel)) return null
  return { provider, model, fullModel, free: option.free === true }
}