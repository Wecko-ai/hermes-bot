import type { SessionUsage } from '../types'

/** From this share of the running model's window, Auto acts: a bigger model takes over or the chat is compacted. */
export const AUTO_COMPACT_RATIO = 0.8

export interface ModelFallback {
  fromModel: string
  fromProvider: string
  toModel: string
  toProvider: string
  reason: string
}

const FALLBACK = /Model fallback:\s*(\S+)\s+via\s+(\S+)\s+unavailable\s*(?:\(([^)]*)\))?\s*;\s*using\s+(\S+)\s+via\s+([^\s.;]+)/i

/**
 * Hermes's own fallback (« ⚠️ Model fallback: X via P unavailable (rate limit); using Y via Q. »): the turn
 * no longer runs on the model Auto picked, so the label and the context checks must follow the real one.
 */
export function parseModelFallback(text: unknown): ModelFallback | null {
  if (typeof text !== 'string') return null
  const match = text.match(FALLBACK)
  if (!match) return null
  return { fromModel: match[1], fromProvider: match[2], reason: (match[3] || '').trim(), toModel: match[4], toProvider: match[5] }
}

/** Routed id of the fallback model, as the Auto label expects it (`provider/model`). */
export function fallbackRouteId(fallback: ModelFallback) {
  return `${fallback.toProvider}/${fallback.toModel}`
}

/** The conversation is at or above the share of its model's window where Auto must act. */
export function nearAutoLimit(usage: Pick<SessionUsage, 'contextUsed' | 'contextMax'> | null | undefined, ratio = AUTO_COMPACT_RATIO) {
  return Boolean(usage && usage.contextMax > 0 && usage.contextUsed >= usage.contextMax * ratio)
}

/**
 * Idle Auto chat close to its window: check once per (session, compaction count), so a compaction that
 * did not shrink enough does not loop.
 */
export function autoCompactKey(sessionId: string, usage: Pick<SessionUsage, 'compressions'> | null | undefined) {
  return `${sessionId}#${usage?.compressions ?? 0}`
}

export function shouldCheckAutoCompact(input: {
  autoActive: boolean
  running: boolean
  compacting: boolean
  sessionId: string
  usage: Pick<SessionUsage, 'contextUsed' | 'contextMax' | 'compressions'> | null | undefined
  lastKey: string
}) {
  if (!input.autoActive || input.running || input.compacting || !input.sessionId) return false
  if (!nearAutoLimit(input.usage)) return false
  return autoCompactKey(input.sessionId, input.usage) !== input.lastKey
}
