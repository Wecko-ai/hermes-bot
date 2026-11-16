import { isStaleGeneration } from './gateway-errors'

const TURN_END_STATUSES = new Set(['complete', 'interrupted', 'error'])

/**
 * A `message.complete` ends the running turn only when it carries a terminal status
 * (`complete`, `interrupted`, `error`) or an `execution_generation`.
 * A cancelled or replaced queued admission has `outcome` and empty text, and neither
 * `status` nor `execution_generation`: that is not the end of the turn still running.
 */
export function isRunningTurnEnd(event: { execution_generation?: unknown; payload?: Record<string, unknown> }) {
  const payload = event.payload ?? {}
  const status = typeof payload.status === 'string' ? payload.status : ''
  if (TURN_END_STATUSES.has(status)) return true
  const text = typeof payload.text === 'string' ? payload.text : ''
  const outcome = payload.outcome
  const hasOutcome = outcome !== undefined && outcome !== null && outcome !== ''
  if (hasOutcome && !text.trim()) return false
  if (!status && typeof event.execution_generation !== 'number') return false
  return typeof event.execution_generation === 'number'
}

/** Final text of a completion: the payload when it has text, otherwise the streaming buffer. */
export function completedText(payloadText: unknown, buffered: string) {
  return typeof payloadText === 'string' && payloadText.trim() ? payloadText : buffered
}

export function appendSessionStream(buffers: Map<string, string>, sessionId: string, text: string) {
  if (!sessionId || !text) return
  buffers.set(sessionId, (buffers.get(sessionId) ?? '') + text)
}

/** Reads and clears one session's off-screen streaming buffer. */
export function takeSessionStream(buffers: Map<string, string>, sessionId: string) {
  const text = buffers.get(sessionId) ?? ''
  buffers.delete(sessionId)
  return text
}

/**
 * Generation a priority send must interrupt: the one copied before `prompt.submit`.
 * `afterSubmit` is the generation the store may have moved to while the submit was in flight;
 * it is never used. A `stale_generation` error is not retried with that newer generation.
 */
export function interruptGenerationForPriority(beforeSubmit: number, afterSubmit: number, error?: unknown): number | null {
  // `afterSubmit` is the generation the store may show once submit returns. Never interrupt that one.
  void afterSubmit
  if (isStaleGeneration(error) || error) return null
  return beforeSubmit
}

/** A replay gap ends the subscription for that session. Resume only when it is the one on screen. */
export function replayGapResumes(eventSessionId: string | undefined, openSessionId: string | undefined) {
  return Boolean(eventSessionId && openSessionId && eventSessionId === openSessionId)
}

/** `session.interrupt` already found the session idle: the turn is not running. */
export function interruptLeftSessionIdle(result: unknown) {
  if (!result || typeof result !== 'object') return false
  return (result as { execution_state?: unknown }).execution_state === 'idle'
}
