/**
 * Context windows for Auto: a model is only a candidate when the conversation fits in its window with
 * room left for the reply and tool results. When nothing fits, the largest window is kept and the
 * conversation has to be compacted first.
 */

/** Share of the window kept free for the reply, tool outputs and the next steps of the turn. */
export const CONTEXT_HEADROOM = 0.25
/** From this share of the current model's window, Auto compacts when no bigger model can take over. */
export const AUTO_COMPACT_RATIO = 0.8
/** Window assumed for a model the table does not describe: conservative, most models have at least this. */
export const UNKNOWN_CONTEXT_WINDOW = 128_000

function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** `contextWindow` from the scoring table (exact id, else the model's last segment). */
export function tableContextWindow(table, fullId) {
  const entry = table?.models?.[fullId] || table?.models?.[String(fullId).split('/').slice(-1)[0]]
  return positive(entry?.contextWindow)
}

/**
 * Window to plan with for one candidate. For the model the session runs on now, the gateway's own figure
 * (`contextMax`) wins when it is smaller: the gateway compacts and refuses by its own number.
 */
export function candidateWindow(row, { table, currentModel = '', contextMax = 0 }) {
  const fromTable = tableContextWindow(table, row.fullModel || `${row.provider}/${row.model}`)
  const isCurrent = Boolean(currentModel) && (row.model === currentModel || row.fullModel === currentModel)
  const live = isCurrent ? positive(contextMax) : 0
  if (fromTable && live) return Math.min(fromTable, live)
  return fromTable || live || UNKNOWN_CONTEXT_WINDOW
}

/** Tokens the conversation needs fit in the window minus the headroom. */
export function fitsContext(window, needed, headroom = CONTEXT_HEADROOM) {
  return needed <= window * (1 - headroom)
}

/**
 * Keeps the candidates whose window fits `needed` tokens. When none fits, returns the largest-window
 * candidate alone with `needsCompaction`.
 */
export function filterByContext(candidates, needed, options) {
  const sized = candidates.map((row) => ({ ...row, contextWindow: candidateWindow(row, options) }))
  if (!sized.length || needed <= 0) return { candidates: sized, needsCompaction: false, excluded: [] }
  const fitting = sized.filter((row) => fitsContext(row.contextWindow, needed))
  const excluded = sized.filter((row) => !fitting.includes(row)).map((row) => row.fullModel)
  if (fitting.length) return { candidates: fitting, needsCompaction: false, excluded }
  const largest = [...sized].sort((a, b) => b.contextWindow - a.contextWindow)[0]
  return { candidates: [largest], needsCompaction: true, excluded: excluded.filter((id) => id !== largest.fullModel) }
}

/** The conversation is close to the window of the model it runs on: compact unless another model takes over. */
export function nearContextLimit(contextUsed, window, ratio = AUTO_COMPACT_RATIO) {
  return window > 0 && contextUsed >= window * ratio
}
