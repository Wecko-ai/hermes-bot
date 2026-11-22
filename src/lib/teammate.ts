import { useSyncExternalStore } from 'react'
import type { ChatMessage } from '../types'

/**
 * Shared teammate note. Read with each turn of a profile that has it on (the default).
 * It is an instruction for that turn only: the bot's profile is never rewritten.
 * The model reads English. The note stays one bracket pair so the thread can hide it.
 */
export const TEAMMATE_FRAGMENT = 'You work in the background like a teammate. For this turn only: reply first with one short acknowledgement sentence in the user\'s language, before any tool call. Then do the work and do not narrate each command. At a meaningful milestone only, write a single line that starts with PROGRESS: followed by one short sentence of what changed and what is left. Never start the acknowledgement or the final answer with PROGRESS:. End the turn with a clear final result: the outcome first, then only what the user must decide or do. A PROGRESS line is not the final answer.'

const STORAGE_KEY = 'hermesbot-teammate'
const MAX_FRAGMENT = 900
const MAX_LINE = 240

/** A milestone line the model writes on its own, or the body of a gateway `progress` event. */
const PROGRESS_LINE = /^PROGRESS:\s*(.+?)\s*$/i

export interface TeammatePrefs {
  /** Profiles that opted out. Missing means on. */
  disabled: string[]
  /** Custom fragment. Empty uses {@link TEAMMATE_FRAGMENT}. */
  fragment: string
}

interface NarrationState {
  ack?: string
  progress: string[]
}

const EMPTY: TeammatePrefs = { disabled: [], fragment: '' }

export function parseTeammatePrefs(raw: string | null): TeammatePrefs {
  try {
    const value = JSON.parse(raw || '{}') as { disabled?: unknown; fragment?: unknown }
    const disabled = Array.isArray(value.disabled)
      ? [...new Set(value.disabled.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length < 80))].slice(0, 500)
      : []
    const fragment = typeof value.fragment === 'string' ? value.fragment.replace(/\s+$/g, '').slice(0, MAX_FRAGMENT) : ''
    return { disabled, fragment }
  } catch {
    return { disabled: [], fragment: '' }
  }
}

function readPrefs(): TeammatePrefs {
  try {
    if (typeof localStorage === 'undefined') return { disabled: [], fragment: '' }
    return parseTeammatePrefs(localStorage.getItem(STORAGE_KEY))
  } catch {
    return { disabled: [], fragment: '' }
  }
}

let current = readPrefs()
const listeners = new Set<() => void>()

function publish(next: TeammatePrefs) {
  current = next
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* storage unavailable: the choice stays for this session */ }
  listeners.forEach((listener) => listener())
}

export const getTeammatePrefs = () => current

export function subscribeTeammate(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const useTeammatePrefs = () => useSyncExternalStore(subscribeTeammate, getTeammatePrefs)

/** On unless this profile opted out. An unknown profile is on. */
export function teammateEnabled(slug: string, prefs: TeammatePrefs = current) {
  return Boolean(slug) && !prefs.disabled.includes(slug)
}

export function setTeammateEnabled(slug: string, enabled: boolean) {
  if (!slug) return
  const disabled = current.disabled.filter((item) => item !== slug)
  publish({ ...current, disabled: enabled ? disabled : [...disabled, slug] })
}

/** The fragment the model reads: the edited one, or the built-in text. */
export function teammateFragment(prefs: TeammatePrefs = current) {
  const custom = prefs.fragment.trim()
  return custom || TEAMMATE_FRAGMENT
}

export function saveTeammateFragment(fragment: string) {
  const clean = fragment.replace(/\s+$/g, '').slice(0, MAX_FRAGMENT)
  const next = clean.trim() === TEAMMATE_FRAGMENT.trim() ? '' : clean
  if (next === current.fragment) return
  publish({ ...current, fragment: next })
}

/** One bracket pair, no nested brackets, so the thread can strip the note from history. */
export function teammateNote(fragment = teammateFragment()) {
  const body = fragment.replace(/[[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_FRAGMENT)
  return `[HermesBot teammate: ${body || TEAMMATE_FRAGMENT}]`
}

/** What the model reads when teammate mode is on: the earlier turn text, then the shared note. */
export function teammateApiText(text: string, prior: string | undefined, enabled: boolean) {
  return enabled ? `${prior ?? text}\n\n${teammateNote()}` : prior
}

const clip = (text: string) => (text.length > MAX_LINE ? `${text.slice(0, MAX_LINE - 1).trimEnd()}…` : text)
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase()

/** One assistant message, split into progress lines and the text around them, in order. */
export function splitAssistantPieces(content: string): { text: string; progress: boolean }[] {
  const pieces: { text: string; progress: boolean }[] = []
  let buffer: string[] = []
  const flush = () => {
    const text = buffer.join('\n').trim()
    buffer = []
    if (text) pieces.push({ text, progress: false })
  }
  for (const line of content.split('\n')) {
    const match = PROGRESS_LINE.exec(line.trim())
    if (match?.[1]?.trim()) {
      flush()
      pieces.push({ text: clip(match[1].trim()), progress: true })
    } else buffer.push(line)
  }
  flush()
  return pieces
}

/** Body of a progress line or of a `progress` event. Empty when there is nothing to show. */
export function progressSentence(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return ''
  const line = trimmed.split('\n').map((item) => item.trim()).find(Boolean) ?? ''
  const marked = PROGRESS_LINE.exec(line)
  const body = (marked?.[1] ?? line).trim()
  return body ? clip(body) : ''
}

/** A single short sentence: the acknowledgement, not a step and not the final write-up. */
export function isAcknowledgement(content: string) {
  const line = content.trim()
  if (!line || line.length > 180 || line.includes('\n') || PROGRESS_LINE.test(line)) return false
  const body = line.replace(/[.!?…]+$/u, '').trim()
  return body.length >= 2 && !/[.!?…]/.test(body)
}

export function narrationFromEvent(event: { type?: string; payload?: Record<string, unknown> }): { progress: string[]; interim: string } {
  const text = typeof event.payload?.text === 'string' ? event.payload.text.trim() : ''
  if (event.type === 'progress' || event.type === 'message.progress') {
    const sentence = progressSentence(text)
    return { progress: sentence ? [sentence] : [], interim: '' }
  }
  if (event.type === 'message.interim' && text) {
    const pieces = splitAssistantPieces(text)
    return {
      progress: pieces.filter((piece) => piece.progress).map((piece) => piece.text),
      interim: pieces.filter((piece) => !piece.progress).map((piece) => piece.text).join('\n').trim(),
    }
  }
  return { progress: [], interim: '' }
}

/**
 * Bubbles to append for one gateway event. `progress` and `message.progress` always show.
 * The acknowledgement shows only while teammate mode is on for that profile, and only once per turn.
 */
export function nextNarration(
  state: NarrationState | undefined,
  event: { type?: string; payload?: Record<string, unknown> },
  options: { teammate: boolean; sessionId: string; now: string; silent?: (text: string) => boolean },
): { state: NarrationState; bubbles: ChatMessage[] } {
  if (event.type === 'message.start') return { state: { progress: [] }, bubbles: [] }
  if (event.type !== 'message.interim' && event.type !== 'progress' && event.type !== 'message.progress') {
    return { state: state ?? { progress: [] }, bubbles: [] }
  }
  const narration = narrationFromEvent(event)
  const progress = [...(state?.progress ?? [])]
  const bubbles: ChatMessage[] = []
  for (const line of narration.progress) {
    if (progress.some((item) => normalize(item) === normalize(line))) continue
    progress.push(line)
    bubbles.push({ id: `progress-${options.sessionId}-${progress.length}`, role: 'assistant', content: line, createdAt: options.now, progress: true })
  }
  let ack = state?.ack
  const interim = narration.interim.trim()
  if (!ack && options.teammate && interim && isAcknowledgement(interim) && !options.silent?.(interim)) {
    ack = interim
    bubbles.push({ id: `ack-${options.sessionId}`, role: 'assistant', content: interim, createdAt: options.now, ack: true })
  }
  return { state: { ack, progress }, bubbles }
}

/** Drops an acknowledgement already shown, and returns progress lines the thread does not have yet. */
export function settleAnswer(text: string, seen: readonly string[] = [], acknowledgement?: string) {
  const pieces = splitAssistantPieces(text)
  const seenKeys = new Set(seen.map(normalize))
  const progress: string[] = []
  const rest: string[] = []
  for (const piece of pieces) {
    if (!piece.progress) {
      rest.push(piece.text)
      continue
    }
    const key = normalize(piece.text)
    if (seenKeys.has(key)) continue
    seenKeys.add(key)
    progress.push(piece.text)
  }
  let answer = rest.join('\n\n').trim()
  const ack = acknowledgement?.trim() ?? ''
  if (ack && answer) {
    if (normalize(answer) === normalize(ack)) answer = ''
    else if (answer.startsWith(ack)) answer = answer.slice(ack.length).trim()
  }
  return { answer, progress }
}

export function progressBubble(text: string, id: string, createdAt: string): ChatMessage {
  return { id, role: 'assistant', content: text, createdAt, progress: true }
}

/** Test helper: back to the built-in fragment and every profile on. */
export function resetTeammatePrefs() {
  publish({ ...EMPTY })
}
