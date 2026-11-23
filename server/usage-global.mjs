/** Aggregates gateway `/api/analytics/usage` across roster profiles (read-only). */

const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function tokens(row) {
  return asNumber(row.input_tokens) + asNumber(row.output_tokens)
}

function cost(row, estimated = 'estimated_cost', actual = 'actual_cost') {
  return asNumber(row[actual]) || asNumber(row[estimated])
}

function modelMatchesPrefix(model, prefixes) {
  const id = String(model || '')
  if (!id) return false
  if (!prefixes.length) return true
  return prefixes.some((prefix) => id === prefix || id.startsWith(`${prefix}/`) || id.startsWith(`${prefix}:`))
}

export function aggregateAnalytics(bodies, days) {
  const bots = []
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let reasoningTokens = 0
  let costUsd = 0
  let sessions = 0
  let apiCalls = 0
  const dailyMap = new Map()
  const modelMap = new Map()

  for (const item of bodies) {
    if (!item || item.error) continue
    const { profile, body } = item
    const totals = body.totals && typeof body.totals === 'object' ? body.totals : {}
    const botInput = asNumber(totals.total_input)
    const botOutput = asNumber(totals.total_output)
    inputTokens += botInput
    outputTokens += botOutput
    cacheReadTokens += asNumber(totals.total_cache_read)
    reasoningTokens += asNumber(totals.total_reasoning)
    costUsd += cost(totals, 'total_estimated_cost', 'total_actual_cost')
    sessions += asNumber(totals.total_sessions)
    apiCalls += asNumber(totals.total_api_calls)
    bots.push({
      profile,
      inputTokens: botInput,
      outputTokens: botOutput,
      tokens: botInput + botOutput,
      costUsd: cost(totals, 'total_estimated_cost', 'total_actual_cost'),
      sessions: asNumber(totals.total_sessions),
      apiCalls: asNumber(totals.total_api_calls),
    })

    for (const row of Array.isArray(body.daily) ? body.daily : []) {
      const day = typeof row.day === 'string' ? row.day : ''
      if (!day) continue
      const current = dailyMap.get(day) || { day, tokens: 0, costUsd: 0 }
      current.tokens += tokens(row)
      current.costUsd += cost(row)
      dailyMap.set(day, current)
    }

    for (const row of Array.isArray(body.by_model) ? body.by_model : []) {
      const model = typeof row.model === 'string' ? row.model : ''
      if (!model) continue
      const current = modelMap.get(model) || { model, tokens: 0, costUsd: 0 }
      current.tokens += tokens(row)
      current.costUsd += cost(row)
      modelMap.set(model, current)
    }
  }

  const daily = [...dailyMap.values()].sort((a, b) => a.day.localeCompare(b.day))
  const models = [...modelMap.values()].filter((row) => row.tokens > 0).sort((a, b) => b.tokens - a.tokens)

  return {
    days,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    reasoningTokens,
    costUsd,
    sessions,
    apiCalls,
    bots: bots.filter((row) => row.tokens > 0 || row.sessions > 0).sort((a, b) => b.tokens - a.tokens),
    daily,
    models,
  }
}

/** Estimated quota use from today's analytics rows (rolling window approximated by calendar day). */
export function estimateQuotas(summary, quotas, now = new Date()) {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const todayTokens = summary.daily.find((row) => row.day === day)?.tokens ?? 0
  const models = summary.models || []

  return quotas.map((quota) => {
    const used = models.reduce((sum, row) => (modelMatchesPrefix(row.model, quota.modelPrefixes) ? sum + row.tokens : sum), 0)
      || (quota.modelPrefixes.length === 0 ? todayTokens : 0)
    const percent = quota.tokenLimit ? Math.min(100, (used / quota.tokenLimit) * 100) : 0
    const resetsAt = quota.windowHours
      ? new Date(now.getTime() + (quota.windowHours * 3_600_000 - (now.getTime() % (quota.windowHours * 3_600_000)))).getTime()
      : null
    return { ...quota, usedTokens: used, usedPercent: percent, resetsAt, estimated: true }
  })
}

export function profilesFromQuery(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter((item) => PROFILE.test(item)).slice(0, 64)
}