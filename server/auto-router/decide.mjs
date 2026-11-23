import path from 'node:path'
import { estimateTokens } from './classifier.mjs'
import { loadTriageConfig, publicTriage, resolveCategory, weightsForDifficulty } from './triage.mjs'
import { filterByContext, nearContextLimit } from './context.mjs'
import { latencyAverages, readRoutingLog } from './log.mjs'
import { createProviderQuotaStore, isQuotaSignal } from './provider-quota.mjs'
import { freePickReason, rankFreeCandidates, resolveDailyQuota } from './quota.mjs'
import { allowedForSpend, isStrictlyFree, loadScoringTable, normalizeCandidate, pickModel, scoreCandidates } from './scorer.mjs'

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

function spendPolicy(body, subscriptions) {
  const zeroSpend = body.zeroSpend === true
  return {
    zeroSpend,
    subscriptionProviders: subscriptions,
    isFreeModel: (option) => option.free === true,
    isPaidBlocked: (option) => zeroSpend && !option.free && !subscriptions.includes(option.provider),
  }
}

/** Readable name of a table model (« GPT-5.6 Sol (Cursor) »), when the table gives one. */
function labelOf(table, fullId) {
  const label = table?.models?.[fullId]?.label
  return typeof label === 'string' && label.trim() ? label.trim() : ''
}

/**
 * @param {{ tablePath: string, logDir: string, subscriptions?: string[], resolveQuotas?: () => Promise<object[]> }} deps
 */
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

    const rawCandidates = Array.isArray(body.models) ? body.models : []
    const policy = spendPolicy(body, deps.subscriptions || [])
    const mode = body.mode === 'auto-free' ? 'auto-free' : 'auto'
    const table = await loadTable()
    // Auto gratuit is decided here, never trusted from the window's `free` flags.
    const eligible = rawCandidates.map(normalizeCandidate).filter(Boolean)
      .filter((row) => (mode === 'auto-free' ? isStrictlyFree(row, table) : allowedForSpend(row, policy)))
    if (!eligible.length) {
      return { ok: false, error: mode === 'auto-free' ? 'no_free_candidates' : 'no_candidates', category, mode, tokenEstimate: tokens, triage: triagePublic }
    }

    const usage = await quotaStore.snapshot()
    const candidates = eligible.filter((row) => !quotaStore.blocked(usage, table, row, tokens))
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
    const ranked = mode === 'auto-free' ? rankFreeCandidates(scored, quotaOf) : scored

    const quotaThreshold = typeof table?.quotaHighWatermark === 'number' ? table.quotaHighWatermark : 85
    const blocked = new Set()
    let picked = null
    while (blocked.size < ranked.length) {
      picked = pickModel(ranked, { blocked, quotaPercents, quotaHighWatermark: quotaThreshold })
      if (!picked) break
      if (mode === 'auto-free') picked = { ...picked, reason: freePickReason(picked, ranked, quotaOf) }
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

    const chosenWindow = sizing.candidates.find((row) => row.fullModel === picked.chosen)?.contextWindow || 0
    return {
      ok: true,
      mode,
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