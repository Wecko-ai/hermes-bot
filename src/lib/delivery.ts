import { i18n } from '../i18n'

/**
 * Sending a message while a bot is working (user request of 2026-11-10):
 * - `wait` (default): nothing is sent. The message stays a draft; the user finishes it after seeing the result.
 * - `queue`: `prompt.submit` with `queued`; Hermes runs it when the current turn is over.
 * - `priority`: the same queue, with a resume instruction in `api_text`, then `session.interrupt` of the
 *   current turn. The bot reads this message right away, then resumes the interrupted task.
 * When the bot is idle, a message is sent normally.
 */
export type DeliveryMode = 'wait' | 'queue' | 'priority'

export const DELIVERY_MODES: { id: DeliveryMode; label: string; title: string }[] = [
  // Getters: the text follows the interface language at read time.
  { id: 'wait', get label() { return i18n.t('delivery.wait.label') }, get title() { return i18n.t('delivery.wait.title') } },
  { id: 'queue', get label() { return i18n.t('delivery.queue.label') }, get title() { return i18n.t('delivery.queue.title') } },
  { id: 'priority', get label() { return i18n.t('delivery.priority.label') }, get title() { return i18n.t('delivery.priority.title') } },
]

const PRIORITY_NOTE = '[HermesBot priority: the user stopped your current task to send this message. Handle it first. Then resume the interrupted task from where it stopped, unless this message changes or cancels it.]'

/** What the model reads for a priority message: the mode text if there is one, then the resume instruction. */
export function priorityApiText(text: string, modeText?: string) {
  return `${modeText ?? text}\n\n${PRIORITY_NOTE}`
}

export function deliveryPlaceholder(delivery: DeliveryMode, botName: string) {
  return i18n.t(`delivery.placeholder.${delivery}`, { name: botName })
}

const DRAFTS_KEY = 'hermesbot-drafts'
const MAX_DRAFT = 50_000

function readDrafts(): Record<string, string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(DRAFTS_KEY) || '{}')
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {}
    return Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  } catch {
    return {}
  }
}

/** A bot’s text draft, kept when the app closes or the chat changes. Files are not kept. */
export function loadDraft(slug: string) {
  return readDrafts()[slug] ?? ''
}

export function saveDraft(slug: string, text: string) {
  const drafts = readDrafts()
  if ((drafts[slug] ?? '') === text) return
  if (text.trim()) drafts[slug] = text.slice(0, MAX_DRAFT)
  else delete drafts[slug]
  try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts)) } catch { /* storage unavailable: the draft stays in memory */ }
}
