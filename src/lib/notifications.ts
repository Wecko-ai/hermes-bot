import type { BotStatus, ChatMessage } from '../types'
import { isSilentMessage, withoutSilentMarkers } from './hermes'
import { parseIncomingAgentMessage } from './inter-agent'

export type NotificationKind = 'done' | 'question' | 'approval' | 'draft' | 'routine'

const BUSY: BotStatus[] = ['working', 'thinking']

/** Which notification a status change deserves, if any. An unknown previous status (first read) never notifies. */
export function notificationForStatus(previous: BotStatus | undefined, next: BotStatus): NotificationKind | null {
  if (!previous || previous === next) return null
  if (next === 'done' && BUSY.includes(previous)) return 'done'
  if (next === 'waiting') return 'question'
  return null
}

/** Distinguishes an approval card from a clarify question while the bot is `waiting`. */
export function notificationForWaiting(sessionId: string | undefined, prompts: { sessionId: string; kind: string }[]): NotificationKind {
  if (sessionId && prompts.some((prompt) => prompt.sessionId === sessionId && prompt.kind === 'approval')) return 'approval'
  return 'question'
}

/** Methods of a gateway request that wait on the user's answer. */
const APPROVAL_METHODS = new Set(['approval'])

export function notificationForRequest(method: string): NotificationKind | null {
  if (APPROVAL_METHODS.has(method)) return 'approval'
  if (method.startsWith('vault.')) return 'question'
  return null
}

/** How the latest turn of each bot began and ended. Memory only. `known` is false until this turn's user row is read. */
const turns = new Map<string, { fromBot: boolean; silent: boolean; known: boolean }>()

/**
 * Follows a bot's turns from its events. `message.start` on the current gateway carries no prompt text,
 * so it only opens a new turn: the previous turn's flags are dropped. `message.complete` records silence.
 * Who started the turn comes from `noteTurnInput`.
 */
export function noteTurnEvent(slug: string, event: { type?: string; payload?: Record<string, unknown> }) {
  const text = typeof event.payload?.text === 'string' ? event.payload.text : undefined
  if (event.type === 'message.start') turns.set(slug, { fromBot: false, silent: false, known: false })
  // No text in the frame: the reply is unknown, never taken for silence.
  else if (event.type === 'message.complete') {
    const current = turns.get(slug)
    turns.set(slug, {
      fromBot: current?.known ? current.fromBot : false,
      known: current?.known ?? false,
      silent: text !== undefined && (!text.trim() || isSilentMessage(text)),
    })
  }
}

/**
 * Silence from the text actually shown. A completion frame can omit the reply and leave it in the
 * streaming buffer; that text replaces the frame's empty string before a finished-turn notification.
 */
export function noteTurnSilence(slug: string, text: string) {
  const current = turns.get(slug)
  if (!current) return
  turns.set(slug, { ...current, silent: !text.trim() || isSilentMessage(text) })
}

/**
 * The user row that started this turn (history or `session.events.since`). `null` means it could not be
 * read: the previous turn's flag is not reused. `reply` sets silence when the completion text is known.
 */
export function noteTurnInput(slug: string, input: string | null, reply?: string | null) {
  const current = turns.get(slug)
  const silent = reply == null ? Boolean(current?.silent) : !reply.trim() || isSilentMessage(reply)
  turns.set(slug, {
    fromBot: input !== null && parseIncomingAgentMessage(input, slug) !== null,
    silent,
    known: input !== null,
  })
}

/** Text of each bot's last finished turn, as shown, with the time it ended. Memory only. */
const finishedReplies = new Map<string, { text: string; at: number }>()

/** Records the reply of a turn that just ended, so its notification never shows an older message. */
export function noteTurnReply(slug: string, text: string, now = Date.now()) {
  finishedReplies.set(slug, { text: withoutSilentMarkers(text), at: now })
}

/** The reply recorded for the turn that just ended, if it is recent; otherwise undefined. */
export function recordedReply(slug: string, now = Date.now()) {
  const entry = finishedReplies.get(slug)
  if (!entry || now - entry.at > REPLY_FRESH_MS) return undefined
  return entry.text && !isSilentMessage(entry.text) ? entry.text : undefined
}

/** Drops the previous turn so a later finish cannot inherit its flags. */
export function forgetTurn(slug: string) {
  turns.delete(slug)
  finishedReplies.delete(slug)
}

function rowRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((part) => {
    if (typeof part === 'string') return part
    const item = rowRecord(part)
    if (typeof item.text === 'string') return item.text
    if (typeof item.content === 'string') return item.content
    return ''
  }).filter(Boolean).join('\n')
}

function messageText(message: Record<string, unknown>) {
  for (const candidate of [message.text, message.content, message.display_text]) {
    const text = textOf(candidate)
    if (text.trim()) return text
  }
  return ''
}

/**
 * Latest turn input and reply from history rows or session events.
 * An empty `message.start` payload does not count as the input.
 */
export function turnEndsFromRows(rows: unknown[]): { input: string | null; reply: string | null } {
  let reply: string | null = null
  let input: string | null = null
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rowRecord(rows[index])
    const nested = rowRecord(row.message)
    const message = Object.keys(nested).length ? { ...row, ...nested } : row
    const type = typeof row.type === 'string' ? row.type : ''
    const payload = rowRecord(row.payload)
    const payloadText = typeof payload.text === 'string' ? payload.text : ''
    if (type === 'message.complete' && reply === null) reply = payloadText
    const role = typeof message.role === 'string' ? message.role : ''
    const content = messageText(message)
    if (reply === null && role === 'assistant') reply = content
    if (type === 'message.start' && payloadText.trim()) {
      input = payloadText
      break
    }
    if (role === 'user' && content.trim()) {
      input = content
      break
    }
  }
  return { input, reply }
}

/**
 * Whether the bot's finished turn was for the user: not started by another bot's message, and not ended in
 * silence. Unknown input does not notify — a previous turn's flag is never reused.
 */
export function turnForUser(slug: string) {
  const turn = turns.get(slug)
  if (!turn?.known) return false
  return !turn.fromBot && !turn.silent
}

/** Full reset (tests). */
export function resetTurns() {
  turns.clear()
  finishedReplies.clear()
}

/** The bot's own chat open in a focused window: everything is already in view. */
export function shouldNotify(options: { enabled: boolean; focused: boolean; viewing: boolean }) {
  return options.enabled && !(options.focused && options.viewing)
}

/** How recent the cached reply must be to stand for the turn that just ended. */
const REPLY_FRESH_MS = 2 * 60_000

/**
 * The bot's reply to show for a finished turn: the last cached message, if it is the bot's and recent.
 * A turn seen only through the status polling has no reply in the cache: an older one would read as new,
 * so the notification gives the state instead. Same for a silent turn, cached as a technical message.
 */
type ReplyMessage = Pick<ChatMessage, 'role' | 'content' | 'createdAt' | 'technical' | 'progress' | 'agent'>

/** Last finished assistant sentence of this turn, skipping trailing progress and tool rows. */
export function turnReply(messages: ReplyMessage[], now = Date.now()) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const last = messages[index]
    if (!last) continue
    // A step or tool row may sit after the reply; it is not the answer, nor the end of the search.
    if (last.progress || last.role === 'tool') continue
    if (last.role !== 'assistant' || last.technical || last.agent) return undefined
    const at = Date.parse(last.createdAt ?? '')
    if (!Number.isFinite(at) || now - at > REPLY_FRESH_MS) return undefined
    return last.content
  }
  return undefined
}

/** Drop markdown, code, and tool-call markers so a notification shows the spoken sentence. */
export function cleanNotificationText(text: string | undefined) {
  if (!text) return ''
  let value = text
  value = value.replace(/```[\s\S]*?```/g, ' ')
  value = value.replace(/`([^`]+)`/g, '$1')
  value = value.replace(/\[Tool calls?:[\s\S]*?\]/gi, ' ')
  value = value.replace(/^\s*\[Tool call\][^\n]*/gim, ' ')
  value = value.replace(/^\s*Shell command:[^\n]*/gim, ' ')
  value = value.replace(/\*\*([^*]+)\*\*/g, '$1')
  value = value.replace(/__([^_]+)__/g, '$1')
  value = value.replace(/(^|\s)\*([^*]+)\*(?=\s|$)/g, '$1$2')
  value = value.replace(/^#{1,6}\s+/gm, '')
  return value.replace(/\s+/g, ' ').trim()
}

/** One line of the message, at most `max` characters. */
export function notificationExcerpt(text: string | undefined, max = 120) {
  const line = cleanNotificationText(text)
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * Body of a finished-turn notification: the recorded final text, else the last
 * non-tool assistant sentence, else a short fallback (never raw tool-call text).
 */
export function notificationBody(options: {
  recorded?: string
  messages?: ReplyMessage[]
  fallback: string
  now?: number
  max?: number
}) {
  const excerpt = notificationExcerpt(options.recorded, options.max)
  if (excerpt) return excerpt
  const reply = turnReply(options.messages || [], options.now ?? Date.now())
  return notificationExcerpt(reply, options.max) || options.fallback
}

/**
 * Whether the live statuses are still worth reading while the window is hidden (minimized, covered by
 * another window or a full-screen app, in another Space): only while a bot works, so that the end of its
 * turn is seen, and notified, when it happens. A turn that starts is announced by `sessions.changed`.
 * A bot waiting on an answer has already been notified, and needs that answer to move.
 */
export function watchWhileHidden(bots: { status: BotStatus }[]) {
  return bots.some((bot) => BUSY.includes(bot.status))
}

export type TestNotificationResult = 'shown' | 'failed' | 'silent' | 'unsupported'

/**
 * One notification like the app's, and what the system did with it: shown, refused, or no answer at all
 * (macOS drops the notifications of an app whose signature does not carry its bundle identifier).
 */
export async function sendTestNotification(options: { title: string; body: string; onClick?: () => void; timeoutMs?: number }): Promise<TestNotificationResult> {
  if (typeof Notification === 'undefined') return 'unsupported'
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
  if (permission !== 'granted') return 'failed'
  return new Promise((resolve) => {
    const notification = new Notification(options.title, { body: options.body, tag: 'hermesbot-test' })
    const timer = setTimeout(() => resolve('silent'), options.timeoutMs ?? 4_000)
    const settle = (result: TestNotificationResult) => () => { clearTimeout(timer); resolve(result) }
    notification.onshow = settle('shown')
    notification.onerror = settle('failed')
    notification.onclick = () => {
      options.onClick?.()
      notification.close()
    }
  })
}
