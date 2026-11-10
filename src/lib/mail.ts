import type { ChatMessage } from '../types'

/** Draft proposed by a bot in a ````hermes-mail block, editable before sending. */
export interface MailDraft {
  id: string
  draftId: string
  from: string
  to: string
  cc: string
  subject: string
  replyLabel: string
  body: string
}

export const MAIL_FENCE = 'hermes-mail'
export const MAIL_APPROVED_FENCE = 'hermes-mail-approved'

const HEADERS = new Map<string, keyof MailDraft>([
  ['id', 'id'], ['draft-id', 'draftId'], ['from', 'from'], ['to', 'to'], ['cc', 'cc'], ['subject', 'subject'], ['reply-label', 'replyLabel'],
])

const oneLine = (value: string) => value.replace(/[\r\n]+/g, ' ').trim()
const normalizedBody = (value: string) => value.replace(/\r\n/g, '\n').replace(/\s+$/, '')

/** Headers, blank line, body: the very format of a mail, safer for a model to write than JSON. */
export function parseMailBlock(source: string): MailDraft | null {
  const text = source.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\n+$/, '')
  const split = text.indexOf('\n\n')
  const head = split < 0 ? text : text.slice(0, split)
  const draft: MailDraft = { id: '', draftId: '', from: '', to: '', cc: '', subject: '', replyLabel: '', body: split < 0 ? '' : text.slice(split + 2) }
  for (const line of head.split('\n')) {
    const match = /^([A-Za-z-]+):[ \t]*(.*)$/.exec(line)
    const key = match && HEADERS.get(match[1].toLowerCase())
    if (match && key) draft[key] = match[2].trim()
  }
  return draft.id && draft.body ? draft : null
}

const ADDRESS = /(^|<)[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+>?$/
const addresses = (value: string) => value.split(',').map((item) => item.trim()).filter(Boolean)
export const validAddresses = (value: string) => addresses(value).every((item) => ADDRESS.test(item))
export const canSendMail = (draft: MailDraft) => Boolean(draft.from) && addresses(draft.to).length > 0 && validAddresses(draft.to) && validAddresses(draft.cc) && Boolean(draft.body.trim())

/** Fingerprint of what the user approved: the sending script refuses a mail that no longer matches. */
export async function mailDigest(draft: MailDraft) {
  const canonical = [draft.from, draft.draftId, draft.to, draft.cc, draft.subject].map(oneLine).concat(normalizedBody(draft.body)).join('\n').normalize('NFC')
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** The message sent to the bot when a draft is approved. */
export async function approvedMailPrompt(draft: MailDraft) {
  const body = normalizedBody(draft.body)
  const longestRun = Math.max(3, ...[...body.matchAll(/`+/g)].map((match) => match[0].length))
  const fence = '`'.repeat(longestRun + 1)
  return [
    'Mail approuvé : envoie-le une seule fois avec la skill mail-approval.',
    '',
    `${fence}${MAIL_APPROVED_FENCE}`,
    `Id: ${oneLine(draft.id)}`,
    ...(draft.draftId ? [`Draft-Id: ${oneLine(draft.draftId)}`] : []),
    `From: ${oneLine(draft.from)}`,
    `To: ${oneLine(draft.to)}`,
    `Cc: ${oneLine(draft.cc)}`,
    `Subject: ${oneLine(draft.subject)}`,
    `Approved-Digest: ${await mailDigest(draft)}`,
    '',
    body,
    fence,
  ].join('\n')
}

/** Already-approved drafts, found again in the thread: the state survives a reload. */
export function approvedMailIds(messages: ChatMessage[]) {
  const ids = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'user' || message.failed) continue
    const match = /(`{3,})hermes-mail-approved\n([\s\S]*?)\n\1/.exec(message.content)
    const id = match && parseMailBlock(match[2])?.id
    if (id) ids.add(id)
  }
  return ids
}
