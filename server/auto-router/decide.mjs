import path from 'node:path'
import { classifyPrompt, estimateTokens } from './classifier.mjs'
import { filterByContext, nearContextLimit } from './context.mjs'
import { latencyAverages, readRoutingLog } from './log.mjs'
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
export function createAutoRouter(deps) {
  let tableCache = { mtime: 0, table: null }

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
    const category = classifyPrompt({ text, imageCount, contextUsed, contextMax })
    const tokens = estimateTokens(text, contextUsed)

    const rawCandidates = Array.isArray(body.models) ? body.models : []
    const policy = spendPolicy(body, deps.subscriptions || [])
    const mode = body.mode === 'auto-free' ? 'auto-free' : 'auto'
    // Auto gratuit is decided here, never trusted from the window's `free` flags.
    const candidates = rawCandidates.map(normalizeCandidate).filter(Boolean)
      .filter((row) => (mode === 'auto-free' ? isStrictlyFree(row) : allowedForSpend(row, policy)))
    if (!candidates.length) {
      return { ok: false, error: mode === 'auto-free' ? 'no_free_candidates' : 'no_candidates', category, mode, tokenEstimate: tokens }
    }

    const table = await loadTable()
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
    })

    const quotaThreshold = typeof table?.quotaHighWatermark === 'number' ? table.quotaHighWatermark : 85
    const picked = pickModel(scored, { quotaPercents, quotaHighWatermark: quotaThreshold })
    if (!picked) return { ok: false, error: 'no_pick', category, mode, tokenEstimate: tokens }

    const chosenWindow = sizing.candidates.find((row) => row.fullModel === picked.chosen)?.contextWindow || 0
    return {
      ok: true,
      mode,
      category,
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

  return { decide, tablePath: deps.tablePath, logDir: deps.logDir }
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