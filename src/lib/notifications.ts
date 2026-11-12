import type { BotStatus } from '../types'

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

/** One line of the message, at most `max` characters. */
export function notificationExcerpt(text: string | undefined, max = 120) {
  const line = (text || '').replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
