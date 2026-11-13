import type { BotStatus, ChatMessage } from '../types'

export type NotificationKind = 'done' | 'question' | 'approval'

const BUSY: BotStatus[] = ['working', 'thinking']

/** Which notification a status change deserves, if any. An unknown previous status (first read) never notifies. */
export function notificationForStatus(previous: BotStatus | undefined, next: BotStatus): NotificationKind | null {
  if (!previous || previous === next) return null
  if (next === 'done' && BUSY.includes(previous)) return 'done'
  if (next === 'waiting') return 'question'
  return null
}

/** Methods of a gateway request that wait on the user's answer. */
const APPROVAL_METHODS = new Set(['approval'])

export function notificationForRequest(method: string): NotificationKind | null {
  if (APPROVAL_METHODS.has(method)) return 'approval'
  if (method.startsWith('vault.')) return 'question'
  return null
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
export function turnReply(messages: Pick<ChatMessage, 'role' | 'content' | 'createdAt' | 'technical'>[], now = Date.now()) {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant' || last.technical) return undefined
  const at = Date.parse(last.createdAt ?? '')
  return Number.isFinite(at) && now - at <= REPLY_FRESH_MS ? last.content : undefined
}

/** One line of the message, at most `max` characters. */
export function notificationExcerpt(text: string | undefined, max = 120) {
  const line = (text || '').replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
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
