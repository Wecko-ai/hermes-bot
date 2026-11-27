import path from 'node:path'
import { estimateTokens } from './classifier.mjs'
import { loadTriageConfig, publicTriage, resolveCategory, weightsForDifficulty } from './triage.mjs'
import { filterByContext, nearContextLimit } from './context.mjs'
import { latencyAverages, readRoutingLog } from './log.mjs'
import { createProviderQuotaStore, isQuotaSignal, classifyUpstreamError, quotaProviderId, quotaTarget } from './provider-quota.mjs'
import { freePickReason, rankFreeCandidates, resolveDailyQuota } from './quota.mjs'
import { evaluateBotBudget } from './bot-budget.mjs'
import { allowedByCandidateRules, allowedForSpend, isStrictlyFree, loadScoringTable, normalizeCandidate, pickModel, scoreCandidates, tableEntry } from './scorer.mjs'

function quotaMap(rows) {
  const map = new Map()
  for (const row of rows || []) {
    const id = typeof row.id === 'string' ? row.id : ''
    const percent = typeof row.usedPercent === 'number' ? row.usedPercent : 0
    if (!id) continue
    map.set(id, percent)
    for (const prefix of Array.isArray(row.modelPrefixes) ? row.modelPrefixes : []) {
      map.set(prefix, percent)
    }
  }
  return map
}

function spendPolicy(body, subscriptions, table = null) {
  const zeroSpend = body.zeroSpend === true
  // A strictly free route (NVIDIA, local, OpenRouter :free, SambaNova, Cloudflare) is free whatever
  // the caller's flags say: headless callers list table rows without `free`, which used to block them all.
  const isFree = (option) => option.free === true || isStrictlyFree(option, table)
  return {
    zeroSpend,
    subscriptionProviders: subscriptions,
    isFreeModel: isFree,
    isPaidBlocked: (option) => zeroSpend && !isFree(option) && !subscriptions.includes(option.provider),
  }
}

/**
 * Free first: easy turns go to a strictly free model when one meets the quality bar.
 * Table `freeFirst` overrides: { enabled, categories, easyCategories, minQuality }. Rows with
 * `tools: false` or `disabled: true` never route. Subscriptions stay behind as fallbacks.
 */
const FREE_FIRST_DEFAULTS = Object.freeze({
  enabled: true,
  categories: ['quick'],
  easyCategories: ['quick', 'writing', 'other', 'research'],
  minQuality: 0.7,
})

function freeFirstConfig(table) {
  const raw = table && typeof table.freeFirst === 'object' && table.freeFirst !== null ? table.freeFirst : {}
  return { ...FREE_FIRST_DEFAULTS, ...raw }
}

function rowRoutable(table, fullId) {
  const entry = tableEntry(table, fullId)
  return entry?.tools !== false && entry?.disabled !== true
}

export function freeFirstApplies(category, triage, table) {
  const cfg = freeFirstConfig(table)
  if (cfg.enabled === false) return false
  if (triage?.difficulty === 'hard') return false
  if (Array.isArray(cfg.categories) && cfg.categories.includes(category)) return true
  return triage?.difficulty === 'easy' && Array.isArray(cfg.easyCategories) && cfg.easyCategories.includes(category)
}

export function rankFreeFirst(scored, table, quotaOf) {
  const cfg = freeFirstConfig(table)
  const minQuality = Number(cfg.minQuality) || 0
  const good = (row) => isStrictlyFree(row, table)
    && rowRoutable(table, row.fullId)
    && row.quality >= minQuality
  const free = scored.filter(good)
  if (!free.length) return { ranked: scored, applied: false }
  const rest = scored.filter((row) => !free.includes(row))
  return { ranked: [...rankFreeCandidates(free, quotaOf), ...rest], applied: true }
}

/** Readable name of a table model (« GPT-5.6 Sol (Cursor) »), when the table gives one. */
function labelOf(table, fullId) {
  const label = tableEntry(table, fullId)?.label
  return typeof label === 'string' && label.trim() ? label.trim() : ''
}

/**
 * @param {{ tablePath: string, logDir: string, subscriptions?: string[], resolveQuotas?: () => Promise<object[]> }} deps
 */
function exhaustionNote(skipped, chosen) {
  const rows = []
  const seen = new Set()
  for (const row of skipped) {
    if (row.fullId && row.fullId === chosen) continue
    const key = row.scope === 'provider' ? `provider|${row.provider}` : `${row.scope}|${row.provider}|${row.model || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    const until = row.until ? ` until ${row.until}` : ''
    if (row.scope === 'provider') rows.push(`provider ${row.provider} exhausted${until}`)
    else rows.push(`model ${row.model} exhausted${until}`)
  }
  if (!rows.length) return ''
  return `skipped ${rows.slice(0, 6).join('; ')}`
}

function optionFromFullId(fullId) {
  const slash = String(fullId || '').indexOf('/')
  if (slash <= 0) return { provider: String(fullId || ''), model: String(fullId || ''), fullModel: String(fullId || '') }
  return { provider: fullId.slice(0, slash), model: fullId.slice(slash + 1), fullModel: fullId }
}

export function createAutoRouter(deps) {
  let tableCache = { mtime: 0, table: null }
  const quotaStore = createProviderQuotaStore(deps.logDir)

  async function loadTable() {
    try {
      const { stat, readFile } = await import('node:fs/promises')
      const st = await stat(deps.tablePath)
      if (tableCache.table && tableCache.mtime === st.mtimeMs) return tableCache.table
      const table = await loadScoringTable(deps.tablePath)
      tableCache = { mtime: st.mtimeMs, table }
      return table
    } catch {
      return { models: {}, weights: {} }
    }
  }

  async function decide(body) {
    const text = typeof body.text === 'string' ? body.text : ''
    // Transient fallback signals (Cursor blob capacity, ocx_client_tool_search) skip that provider
    // for this turn only; persisted quota stays untouched.
    const transientSkip = new Set()
    if (Array.isArray(body.turnErrors)) {
      for (const hint of body.turnErrors) {
        if (classifyUpstreamError(hint?.status, hint?.message) !== 'transient_fallback') continue
        const targeted = quotaTarget(hint?.provider, hint?.model)
        if (targeted.provider) transientSkip.add(targeted.provider)
        const targetedId = quotaProviderId(targeted.provider, targeted.model)
        if (targetedId) transientSkip.add(targetedId)
      }
    }
    if (Array.isArray(body.excludeProviders)) {
      for (const provider of body.excludeProviders) {
        if (typeof provider === 'string' && provider) transientSkip.add(provider)
      }
    }
    if (transientSkip.size) {
      const expanded = new Set()
      for (const provider of transientSkip) {
        expanded.add(provider)
        expanded.add(quotaProviderId(provider, ''))
      }
      transientSkip.clear()
      for (const provider of expanded) transientSkip.add(provider)
    }
    const imageCount = Number(body.imageCount) || 0
    const contextUsed = Number(body.contextUsed) || 0
    const contextMax = Number(body.contextMax) || 0
    const triageConfig = deps.triageConfig || loadTriageConfig()
    const triage = await resolveCategory({
      text,
      summary: typeof body.summary === 'string' ? body.summary : '',
      imageCount,
      contextUsed,
      contextMax,
      bot: typeof body.bot === 'string' ? body.bot : '',
      forceLocal: body.forceLocal === true,
    }, triageConfig, deps.triageDeps || {})
    const category = triage.category
    const tokens = estimateTokens(text, contextUsed)
    const triagePublic = publicTriage(triage)
    const budget = evaluateBotBudget({ botId: typeof body.bot === 'string' ? body.bot : '', dailyTokens: Number(body.dailyTokens) || 0, interactive: body.interactive === true, targets: deps.botBudgets })

    const rawCandidates = Array.isArray(body.models) ? body.models : []
    const mode = body.mode === 'auto-free' ? 'auto-free' : 'auto'
    const table = await loadTable()
    const policy = spendPolicy(body, deps.subscriptions || [], table)
    // Auto gratuit is decided here, never trusted from the window's `free` flags.
    let eligible = rawCandidates.map(normalizeCandidate).filter(Boolean)
      .filter((row) => allowedByCandidateRules(row, table))
      // Hermes turns carry tools, and retired models are marked disabled: neither should route.
      .filter((row) => rowRoutable(table, row.fullModel))
      .filter((row) => (mode === 'auto-free' ? isStrictlyFree(row, table) : allowedForSpend(row, policy)))
    if (budget.downgrade) {
      const free = eligible.filter((row) => isStrictlyFree(row, table))
      if (free.length) eligible = free
    }
    if (!eligible.length) {
      return { ok: false, error: mode === 'auto-free' ? 'no_free_candidates' : 'no_candidates', category, mode, tokenEstimate: tokens, triage: triagePublic }
    }

    const usage = await quotaStore.snapshot()
    const skippedExhausted = []
    const skippedTransient = []
    const candidates = eligible.filter((row) => {
      if (transientSkip.has(row.provider) || transientSkip.has(quotaProviderId(row.provider, row.model))) {
        skippedTransient.push(row.provider)
        return false
      }
      const block = quotaStore.blockDetail(usage, table, row, tokens)
      if (!block) return true
      skippedExhausted.push({ ...block, fullId: row.fullModel })
      return false
    })

    if (!candidates.length) {
      return { ok: false, error: 'quota_exhausted', category, mode, tokenEstimate: tokens, triage: triagePublic }
    }

    // Never route to a model the conversation does not fit in (window minus headroom for the reply and tools).
    const currentModel = typeof body.currentModel === 'string' ? body.currentModel : ''
    const sizing = filterByContext(candidates, tokens, { table, currentModel, contextMax })
    const recent = await readRoutingLog(deps.logDir, 14)
    const latencyMs = latencyAverages(recent)
    const serverQuotas = deps.resolveQuotas ? await deps.resolveQuotas() : []
    const quotaPercents = serverQuotas.length ? quotaMap(serverQuotas) : quotaMap(body.quotas)

    const scored = scoreCandidates({
      table,
      category,
      candidates: sizing.candidates,
      latencyMs,
      quotaPercents,
      ...(triage.source === 'local' ? { weights: weightsForDifficulty(triage.difficulty) } : {}),
    })
    const quotaOf = (row) => resolveDailyQuota(table, row)
    let freeFirst = false
    let ranked = scored
    if (mode === 'auto-free') ranked = rankFreeCandidates(scored, quotaOf)
    else if (freeFirstApplies(category, triage, table)) {
      const result = rankFreeFirst(scored, table, quotaOf)
      ranked = result.ranked
      freeFirst = result.applied
    }

    const quotaThreshold = typeof table?.quotaHighWatermark === 'number' ? table.quotaHighWatermark : 85
    const blocked = new Set()
    let picked = null
    while (blocked.size < ranked.length) {
      picked = pickModel(ranked, { blocked, quotaPercents, quotaHighWatermark: quotaThreshold, table })
      if (!picked) break
      if (mode === 'auto-free') picked = { ...picked, reason: freePickReason(picked, ranked, quotaOf) }
      else if (freeFirst && isStrictlyFree({ provider: picked.provider, model: picked.model, fullModel: picked.chosen }, table)) {
        picked = { ...picked, reason: `Free first (${category}): ${picked.reason}` }
      }
      let reserved = false
      try {
        reserved = await quotaStore.reserve({
          table,
          provider: picked.provider,
          model: picked.model,
          fullId: picked.chosen,
          mode,
          label: labelOf(table, picked.chosen),
          reason: picked.reason,
          tokensIn: tokens,
          fallbackFrom: null,
        })
      } catch {
        break
      }
      if (reserved) break
      blocked.add(picked.chosen)
      picked = null
    }
    if (!picked) return { ok: false, error: 'quota_exhausted', category, mode, tokenEstimate: tokens, triage: triagePublic }
    const skipNote = exhaustionNote(skippedExhausted, picked.chosen)
    const uniqTransient = [...new Set(skippedTransient)]
    const transientNote = uniqTransient.length ? `skipped transient ${uniqTransient.join(', ')}` : ''
    const notes = [skipNote, transientNote].filter(Boolean)
    if (notes.length) picked = { ...picked, reason: `${picked.reason}; ${notes.join('; ')}` }

    const chosenWindow = sizing.candidates.find((row) => row.fullModel === picked.chosen)?.contextWindow || 0
    return {
      ok: true,
      mode,
      ...(budget.alert ? { budgetAlert: budget.level } : {}),
      category,
      triage: triagePublic,
      tokenEstimate: tokens,
      contextWindow: chosenWindow,
      // Nothing can hold the conversation with room to work: compact before the turn.
      needsCompaction: sizing.needsCompaction || nearContextLimit(tokens, chosenWindow),
      ...(sizing.excluded.length ? { excludedForContext: sizing.excluded } : {}),
      chosen: picked.chosen,
      ...(labelOf(table, picked.chosen) ? { label: labelOf(table, picked.chosen) } : {}),
      provider: picked.provider,
      model: picked.model,
      reason: picked.reason,
      candidates: picked.candidates,
      fallbacks: picked.fallbacks.map((row) => ({
        provider: row.provider,
        model: row.model,
        fullId: row.fullId,
        ...(labelOf(table, row.fullId) ? { label: labelOf(table, row.fullId) } : {}),
        score: row.score,
      })),
    }
  }

  async function recordLoggedUsage(entry, hints = []) {
    if (!entry || typeof entry !== 'object') return
    const table = await loadTable()
    const mode = entry.mode === 'auto-free' ? 'auto-free' : 'auto'
    const seen = new Set()
    for (const row of Array.isArray(entry.fallbacks) ? entry.fallbacks : []) {
      const fullId = typeof row?.model === 'string' ? row.model : ''
      if (!fullId || seen.has(fullId)) continue
      seen.add(fullId)
      const option = optionFromFullId(fullId)
      try {
        await quotaStore.recordUse({
          table,
          provider: option.provider,
          model: option.model,
          fullId,
          mode,
          label: '',
          reason: 'fallback',
          tokensIn: 0,
          tokensOut: 0,
          fallbackFrom: typeof entry.chosen === 'string' ? entry.chosen : null,
        })
      } catch { /* the routing log already landed; the counter is best-effort */ }
    }
    const explicit = Array.isArray(hints) ? hints : []
    const errors = explicit.length ? explicit : (Array.isArray(entry.fallbacks) ? entry.fallbacks : []).flatMap((row) => {
      const message = typeof row?.error === 'string' ? row.error : ''
      if (!isQuotaSignal(null, message)) return []
      const option = optionFromFullId(row.model)
      return [{ provider: option.provider, model: option.model, status: /\b402\b/.test(message) ? 402 : 429, message }]
    })
    if (!errors.length) return
    try {
      await quotaStore.noteErrors({ table, errors })
    } catch { /* best-effort, same as the counter */ }
  }

  return { decide, recordLoggedUsage, tablePath: deps.tablePath, logDir: deps.logDir }
}

export function resolveAutoRouterPaths(config, root) {
  const dataDir = config.dataDir
  const auto = config.autoRouter || {}
  const logDir = [auto.logDir].find((value) => typeof value === 'string' && path.isAbsolute(value))
    || path.join(dataDir, 'auto-router')
  const tablePath = [auto.tablePath].find((value) => typeof value === 'string' && path.isAbsolute(value))
    || path.join(root, 'examples', 'auto-router.table.json')
  return { logDir, tablePath }
}