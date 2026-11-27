// Soft per-bot daily budget alerts and auto-downgrade.
// Never blocks or downgrades interactive chat — the app enforces that gate.
//
// Per-bot targets are configuration, not code: `autoRouter.botBudgets` in the config
// ({ "<bot id>": <daily tokens> }). Without an entry a bot gets DEFAULT_TARGET.

export const DEFAULT_TARGET = 3_000_000

export function sanitizeBotBudgets(value) {
  const targets = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return targets
  for (const [key, raw] of Object.entries(value)) {
    const id = String(key).trim()
    const tokens = Number(raw)
    if (id && Number.isFinite(tokens) && tokens > 0) targets[id] = Math.floor(tokens)
  }
  return targets
}

export function botTarget(botId, targets = {}) {
  const key = typeof botId === 'string' ? botId.trim() : ''
  const table = targets && typeof targets === 'object' ? targets : {}
  return Object.hasOwn(table, key) && Number(table[key]) > 0 ? Number(table[key]) : DEFAULT_TARGET
}

export function evaluateBotBudget({ botId, dailyTokens, interactive, targets } = {}) {
  const target = botTarget(botId, targets)
  const tokens = Number(dailyTokens)
  const pct = target > 0 && Number.isFinite(tokens) ? Math.max(0, tokens / target) : 0
  const isInteractive = interactive === true
  if (pct < 0.70) {
    return { level: 'ok', alert: false, downgrade: false, pct }
  }
  if (pct < 0.85) {
    return { level: 'warn_70', alert: true, downgrade: false, pct }
  }
  return {
    level: 'downgrade_85',
    alert: true,
    downgrade: !isInteractive,
    targetTier: isInteractive ? null : 'T2_OR_T0',
    pct,
  }
}
