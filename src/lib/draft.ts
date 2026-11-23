import type { ChatMessage } from '../types'

export type DraftChannel = 'x' | 'slack' | 'telegram'

export interface MessageDraft {
  id: string
  channel: DraftChannel
  recipient: string
  thread: string
  text: string
  attachments: string
}

export const DRAFT_FENCE = 'hermes-draft'
export const DRAFT_APPROVED_FENCE = 'hermes-draft-approved'
const CHANNELS = new Set<DraftChannel>(['x', 'slack', 'telegram'])

const HEADERS = new Map<string, keyof MessageDraft | 'body'>([
  ['id', 'id'], ['channel', 'channel'], ['recipient', 'recipient'], ['thread', 'thread'], ['text', 'text'], ['attachments', 'attachments'],
  ['body', 'body'],
])

const oneLine = (value: string) => value.replace(/[\r\n]+/g, ' ').trim()
const normalizedBody = (value: string) => value.replace(/\r\n/g, '\n').replace(/\s+$/, '')

export function parseDraftBlock(source: string): MessageDraft | null {
  const text = source.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\n+$/, '')
  const split = text.indexOf('\n\n')
  const head = split < 0 ? text : text.slice(0, split)
  const draft: MessageDraft = {
    id: '', channel: 'x', recipient: '', thread: '', text: '', attachments: '',
  }
  let body = split < 0 ? '' : text.slice(split + 2)
  for (const line of head.split('\n')) {
    const match = /^([A-Za-z-]+):[ \t]*(.*)$/.exec(line)
    const key = match && HEADERS.get(match[1].toLowerCase())
    if (match && key === 'body') body = match[2] + (body ? `\n\n${body}` : '')
    else if (match && key === 'id') draft.id = match[2].trim()
    else if (match && key === 'channel') draft.channel = match[2].trim() as DraftChannel
    else if (match && key === 'recipient') draft.recipient = match[2].trim()
    else if (match && key === 'thread') draft.thread = match[2].trim()
    else if (match && key === 'text') draft.text = match[2].trim()
    else if (match && key === 'attachments') draft.attachments = match[2].trim()
  }
  if (!draft.text.trim() && body.trim()) draft.text = body
  const channel = draft.channel.toLowerCase() as DraftChannel
  if (!draft.id || !CHANNELS.has(channel) || !draft.recipient.trim() || !draft.text.trim()) return null
  draft.channel = channel
  return draft
}

export const canSendDraft = (draft: MessageDraft) =>
  Boolean(draft.id.trim()) && CHANNELS.has(draft.channel) && Boolean(draft.recipient.trim()) && Boolean(draft.text.trim())

export const APPROVED_DRAFT_INSTRUCTION = 'Approved draft: send exactly what appears on the card, once, using the outbound skill for this channel.'

export function withoutDraftInstruction(content: string): string {
  if (!content.startsWith(APPROVED_DRAFT_INSTRUCTION)) return content
  return content.slice(APPROVED_DRAFT_INSTRUCTION.length).replace(/^\n+/, '')
}

export async function draftDigest(draft: MessageDraft) {
  const canonical = [draft.channel, draft.recipient, draft.thread, draft.attachments, normalizedBody(draft.text)].map(oneLine).join('\n').normalize('NFC')
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function approvedDraftDocument(draft: MessageDraft): Promise<string> {
  return [
    `Id: ${oneLine(draft.id)}`,
    `Channel: ${draft.channel}`,
    `Recipient: ${oneLine(draft.recipient)}`,
    `Thread: ${oneLine(draft.thread)}`,
    `Attachments: ${oneLine(draft.attachments)}`,
    `Approved-Digest: ${await draftDigest(draft)}`,
    '',
    normalizedBody(draft.text),
  ].join('\n')
}

export async function approvedDraftPrompt(draft: MessageDraft) {
  const body = normalizedBody(draft.text)
  const longestRun = Math.max(3, ...[...body.matchAll(/`+/g)].map((match) => match[0].length))
  const fence = '`'.repeat(longestRun + 1)
  return [
    APPROVED_DRAFT_INSTRUCTION,
    '',
    `${fence}${DRAFT_APPROVED_FENCE}`,
    await approvedDraftDocument(draft),
    fence,
  ].join('\n')
}

export function approvedDraftIds(messages: ChatMessage[]) {
  const ids = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'user' || message.failed) continue
    const match = /(`{3,})hermes-draft-approved\n([\s\S]*?)\n\1/.exec(message.content)
    const id = match && parseDraftBlock(match[2])?.id
    if (id) ids.add(id)
  }
  return ids
}