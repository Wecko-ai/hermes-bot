import type { ChatMessage } from '../types'

/** How a `session.history` page meets the replica. */
export type HistorySync = 'full' | 'delta' | 'unchanged' | 'replaced'

export interface HostCapabilities {
  historyDelta?: boolean
  poster?: boolean
  checkedAt?: number
}

export function rowId(id: string) {
  return /^\d+$/.test(id) ? Number(id) : 0
}

export function maxRowId(messages: { id: string }[]) {
  return messages.reduce((max, message) => Math.max(max, rowId(message.id)), 0)
}

export function minRowId(messages: { id: string }[]) {
  const ids = messages.map((message) => rowId(message.id)).filter((id) => id > 0)
  return ids.length ? Math.min(...ids) : 0
}

/**
 * `unchanged` keeps the replica. `delta` overwrites rows that share an id and appends the rest,
 * so an edit lands in place and a new turn stays at the end. `full` and `replaced` are the server list.
 */
export function stitchHistory<T extends { id: string }>(cached: T[], incoming: T[], mode: HistorySync): T[] {
  if (mode === 'unchanged') return cached
  if (mode !== 'delta') return incoming
  const byId = new Map(incoming.map((row) => [row.id, row]))
  const seen = new Set<string>()
  const out = cached.map((row) => {
    const next = byId.get(row.id)
    if (!next) return row
    seen.add(row.id)
    return next
  })
  for (const row of incoming) if (!seen.has(row.id)) out.push(row)
  return out
}

/** A gateway that rejected the new history fields is asked again after ten minutes. */
export function shouldTryDelta(capabilities: HostCapabilities | null | undefined, now = Date.now()) {
  if (!capabilities || capabilities.historyDelta !== false) return true
  return now - (capabilities.checkedAt || 0) > 10 * 60 * 1000
}

export function isGatewayRevision(revision: string | undefined) {
  return typeof revision === 'string' && revision.startsWith('v1|')
}

/** Pending send, retried with the same `submission_id`. */
export interface SendJournalEntry {
  id: string
  profile: string
  sessionId: string
  text: string
  apiText?: string
  images: { path: string; mime: string }[]
  at: number
}

export function withJournalEntry(journal: SendJournalEntry[], entry: SendJournalEntry) {
  return [...journal.filter((item) => item.id !== entry.id), entry].slice(-20)
}

export function withoutJournalEntry(journal: SendJournalEntry[], id: string) {
  return journal.filter((item) => item.id !== id)
}

/** Scroll kept per profile. `stick` means the thread was pinned to the latest line. */
export interface ScrollMemory {
  stick: boolean
  anchorId: string
}

const scrolls = new Map<string, ScrollMemory>()

export function scrollMemory(profile: string) {
  return scrolls.get(profile)
}

export function setScrollMemory(profile: string, memory: ScrollMemory) {
  scrolls.set(profile, memory)
}

export type { ChatMessage }
