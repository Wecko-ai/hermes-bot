import type { AnsweredBy, ChatMessage, SessionUsage } from '../types'
import { fallbackRouteId, parseModelFallback } from './auto-context'
import { autoRouteDisplay } from './auto-route-label'

const STORAGE_KEY = 'hermesbot.answered-by'
const MAX_SESSIONS = 30
const MAX_PER_SESSION = 200

export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** « Composer 2.5 · Cursor (secours) ». [mark] is the localized « (secours) » / « (fallback) ». */
export function answeredLabel(answered: AnsweredBy, mark: string) {
  const name = autoRouteDisplay(answered.chosen)
  return mark ? `${name} ${mark}` : name
}

/** Tooltip: the switch itself, never the prompt. */
export function answeredTitle(answered: AnsweredBy) {
  const from = answered.fromModel ? `${answered.fromModel} → ` : ''
  const reason = answered.reason ? ` (${answered.reason})` : ''
  return `${from}${answered.provider ? `${answered.provider}/` : ''}${answered.model}${reason}`
}

function routeId(provider: string, model: string) {
  const name = model.trim()
  const via = provider.trim()
  if (!name) return via
  if (!via || name.toLowerCase().startsWith(`${via.toLowerCase()}/`)) return name
  return `${via}/${name}`
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function sameModel(left: string, right: string) {
  const a = left.trim().toLowerCase()
  const b = right.trim().toLowerCase()
  if (!a || !b) return false
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
}

export function answeredFromNotice(notice: string): AnsweredBy | null {
  const parsed = parseModelFallback(notice)
  if (!parsed) return null
  return {
    chosen: fallbackRouteId(parsed),
    provider: parsed.toProvider,
    model: parsed.toModel,
    fallback: true,
    fromModel: parsed.fromModel,
    reason: parsed.reason || undefined,
  }
}

/**
 * A `session.usage` frame names `fallback_model` only after Hermes activated a fallback
 * (`usage_stats`: the agent's current model). Ignored when it is still the selected model.
 */
export function answeredFromUsage(payload: Record<string, unknown>, selectedModel?: string): AnsweredBy | null {
  const nested = payload.usage && typeof payload.usage === 'object' ? payload.usage as Record<string, unknown> : {}
  const model = text(payload.fallback_model) || text(nested.fallback_model)
  if (!model) return null
  if (selectedModel && sameModel(model, selectedModel)) return null
  const provider = text(payload.provider) || text(nested.provider)
  return { chosen: routeId(provider, model), provider, model, fallback: true }
}

/** Fallback announced by this gateway event, or null. Status text wins over the usage flag. */
export function answeredFromEvent(type: string, payload: Record<string, unknown>, selectedModel?: string): AnsweredBy | null {
  if (type === 'status.update') return answeredFromNotice(text(payload.text))
  if (type === 'session.usage' || type === 'message.complete') return answeredFromUsage(payload, selectedModel)
  return null
}

/** True when [usage] is the answering model's own frame, not the selected model's leftover. */
export function usageNamesAnswered(usage: { model?: string; provider?: string } | null | undefined, answered: AnsweredBy) {
  if (!usage) return false
  const model = usage.model || ''
  return sameModel(model, answered.model) || sameModel(model, answered.chosen)
    || (usage.provider ? sameModel(routeId(usage.provider, model), answered.chosen) : false)
}

/**
 * The notice names the model it left and why. A later `session.usage` flag for the same model does
 * not replace that.
 */
export function preferAnswered(previous: AnsweredBy | null | undefined, announced: AnsweredBy): AnsweredBy {
  if (previous?.fromModel && !announced.fromModel && usageNamesAnswered({ model: announced.model, provider: announced.provider }, previous)) {
    return previous
  }
  return announced
}

/**
 * Composer context and tok/s. Until this turn has a usage frame, or Hermes fell back and the frame
 * is still the selected model's, both read as « — ». An estimated context on a fallback frame is
 * not shown either. A turn that ended without a real frame stays « — » (`fresh` stays false).
 */
export function composerReadout(usage: SessionUsage | null, input: { running: boolean; fresh: boolean; answered: AnsweredBy | null }): SessionUsage | null {
  if (!input.fresh) return null
  if (input.answered && !usageNamesAnswered(usage, input.answered)) return null
  if (!usage) return null
  if (input.answered && usage.contextEstimated) {
    return { ...usage, contextUsed: 0, contextMax: 0, contextPercent: 0 }
  }
  return usage
}

export function stampAnswered(messages: ChatMessage[], messageId: string | undefined, answered: AnsweredBy) {
  if (!messageId) return messages
  return messages.map((message) => message.id === messageId ? { ...message, answeredBy: answered } : message)
}

/** Assistant replies of a turn whose user message (or the reply itself) recorded the fallback. */
export function answeredByMessage(messages: ChatMessage[]) {
  const replies = new Map<string, AnsweredBy>()
  let current: AnsweredBy | undefined
  for (const message of messages) {
    if (message.technical || message.progress) continue
    if (message.role === 'user') current = message.answeredBy
    else if (message.role === 'assistant') {
      const answered = message.answeredBy ?? current
      if (answered) replies.set(message.id, answered)
    }
  }
  return replies
}

/** The fallback of the turn in progress: the last user message that has one. */
export function currentAnswered(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'user' && !message.technical) return message.answeredBy
  }
  return undefined
}

export function lastTurnUserId(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'user' && !message.technical && !message.progress) return message.id
  }
  return undefined
}

/** Durable ids from `message.complete.persisted_turn`, plus the live ids we already showed. */
export function answeredStorageIds(payload: Record<string, unknown>, ...liveIds: Array<string | undefined>) {
  const ids = new Set<string>()
  for (const id of liveIds) if (id) ids.add(id)
  const turn = payload.persisted_turn && typeof payload.persisted_turn === 'object'
    ? payload.persisted_turn as Record<string, unknown>
    : {}
  for (const key of ['user_row_id', 'final_assistant_row_id']) {
    if (typeof turn[key] === 'number' && turn[key] > 0) ids.add(String(turn[key]))
  }
  for (const key of ['row_ids', 'user_row_ids']) {
    if (!Array.isArray(turn[key])) continue
    for (const id of turn[key]) if (typeof id === 'number' && id > 0) ids.add(String(id))
  }
  return [...ids]
}

type Saved = Record<string, Record<string, AnsweredBy>>

function readStore(storage: KeyValueStore): Saved {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) || '{}')
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as Saved
  } catch {
    return {}
  }
}

export function rememberAnswered(sessionId: string, ids: string[], answered: AnsweredBy, storage: KeyValueStore = globalThis.localStorage) {
  if (!sessionId || ids.length === 0 || !storage) return
  const saved = readStore(storage)
  const session = { ...(saved[sessionId] || {}) }
  for (const id of ids) session[id] = answered
  const trimmed = Object.fromEntries(Object.entries(session).slice(-MAX_PER_SESSION))
  const next = { ...saved, [sessionId]: trimmed }
  const sessions = Object.keys(next)
  if (sessions.length > MAX_SESSIONS) {
    for (const drop of sessions.slice(0, sessions.length - MAX_SESSIONS)) delete next[drop]
  }
  try { storage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* quota: the open thread still has the stamp */ }
}

/** Puts a saved fallback back on history rows (their ids are the gateway row ids). */
export function withRememberedAnswers(sessionId: string, messages: ChatMessage[], storage: KeyValueStore = globalThis.localStorage) {
  if (!sessionId || !storage) return messages
  const session = readStore(storage)[sessionId]
  if (!session) return messages
  let changed = false
  const next = messages.map((message) => {
    const saved = session[message.id]
    if (!saved || message.answeredBy) return message
    changed = true
    return { ...message, answeredBy: saved }
  })
  return changed ? next : messages
}

/**
 * One turn, replayed from gateway frames. [fresh] is false from `message.start` until a usage
 * frame of the model that is actually answering.
 */
export interface FallbackTurnState {
  answered: AnsweredBy | null
  fresh: boolean
  /** Ids that should still show the fallback after a reload. */
  storedIds: string[]
}

export function reduceFallbackTurn(state: FallbackTurnState, event: { type: string; payload: Record<string, unknown> }, selectedModel?: string, usage: SessionUsage | null = null): FallbackTurnState {
  if (event.type === 'message.start') return { answered: null, fresh: false, storedIds: state.storedIds }
  const announced = answeredFromEvent(event.type, event.payload, selectedModel)
  const answered = announced ?? state.answered
  let fresh = state.fresh
  if (announced && event.type === 'status.update') fresh = false
  if (event.type === 'session.usage' || event.type === 'message.complete') {
    fresh = !answered || usageNamesAnswered(usage, answered)
  }
  const storedIds = event.type === 'message.complete' && answered
    ? [...new Set([...state.storedIds, ...answeredStorageIds(event.payload, ...state.storedIds)])]
    : state.storedIds
  return { answered, fresh, storedIds }
}
