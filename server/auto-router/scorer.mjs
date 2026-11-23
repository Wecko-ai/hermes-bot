import fs from 'node:fs/promises'

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,191}$/

function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function modelKey(provider, model) {
  return `${provider}/${model}`
}

function tableQuality(table, fullId, category) {
  const entry = table?.models?.[fullId] || table?.models?.[fullId.split('/').slice(-1)[0]]
  if (!entry || !entry.quality) return 0.5
  return asNumber(entry.quality[category]) || 0.5
}

function tableEntry(table, fullId) {
  return table?.models?.[fullId] || table?.models?.[fullId.split('/').slice(-1)[0]] || null
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
  const entry = table?.models?.[fullId] || table?.models?.[fullId.split('/').slice(-1)[0]]
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
  const weights = { quality: 1, cost: 0.25, quota: 0.35, latency: 0.15, ...(table?.weights || {}), ...(params.weights || {}) }
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
    const score = (weights.quality * quality)
      + (weights.cost * costNorm)
      + (weights.quota * quotaHeadroom)
      + (weights.latency * latencyNorm)
    return {
      provider,
      model,
      fullId,
      score: Math.round(score * 1000) / 1000,
      quality,
      reasonParts: { quality, costNorm, quotaHeadroom, latencyNorm },
    }
  }).sort((a, b) => b.score - a.score)
}

export function pickModel(scored, { blocked = new Set(), quotaPercents = new Map(), quotaHighWatermark = 85 } = {}) {
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
    fallbacks: ranked.slice(1, 3).map((row) => row),
  }
}

export async function loadScoringTable(tablePath) {
  const raw = JSON.parse(await fs.readFile(tablePath, 'utf8'))
  if (!raw || typeof raw !== 'object') throw new Error('invalid_table')
  return raw
}

const LOCAL_PROVIDERS = new Set(['omlx', 'custom:omlx', 'ollama', 'custom:ollama', 'lmstudio', 'custom:lmstudio', 'llamacpp', 'custom:llamacpp', 'vllm', 'custom:vllm', 'local'])

/**
 * "Auto gratuit": models that cost nothing and use no subscription quota. NVIDIA's free developer
 * catalog, servers on this Mac, and OpenRouter's `:free` variants. Subscriptions (Kimi, Cursor,
 * OpenCode Go) and Gemini (its key's billing cannot be checked from here) are left out.
 */
export function isStrictlyFree(option) {
  const provider = String(option?.provider || '').toLowerCase()
  const model = String(option?.model || '').toLowerCase()
  if (provider === 'nvidia') return true
  if (LOCAL_PROVIDERS.has(provider)) return true
  if (provider === 'openrouter' && (model.endsWith(':free') || model === 'openrouter/free')) return true
  return false
}

export function normalizeCandidate(option) {
  const provider = String(option.provider || '')
  const model = String(option.model || '')
  const fullModel = option.fullModel || modelKey(provider, model)
  if (!MODEL_ID.test(fullModel)) return null
  return { provider, model, fullModel, free: option.free === true }
}