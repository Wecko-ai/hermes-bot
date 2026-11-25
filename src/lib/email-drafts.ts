// Email drafts written by a bot with the `email-drafts` agent plugin (hermes-plugins/email-drafts,
// adapted from hermes-bot-kit, MIT). The plugin keeps the drafts; HermesBot reads them through the
// gateway's plugin RPC `plugin.email-drafts.api` and shows the bot's waiting drafts as cards in its chat.
// Nothing is sent without a click on Envoyer: `send` is only ever called from a card button.
import { HermesRpcError, type HermesClient } from './hermes'

type Json = Record<string, unknown>
const asObject = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {})
const text = (value: unknown) => (typeof value === 'string' ? value : '')
const list = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])

export const EMAIL_DRAFTS_METHOD = 'plugin.email-drafts.api'
export type EmailDraftStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'discarded'
export type EmailDraftMode = 'approval' | 'allow' | 'disabled'
const STATUSES = new Set<EmailDraftStatus>(['pending', 'sending', 'sent', 'failed', 'discarded'])
const MODES = new Set<EmailDraftMode>(['approval', 'allow', 'disabled'])

export interface EmailDraftRules { mode: EmailDraftMode; allowed: string[] }
export interface EmailDraftAttachment { path: string; name: string; size: number | null }
export interface EmailDraft {
  id: string
  rev: number
  status: EmailDraftStatus
  from: string
  fromName: string
  signature: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
  attachments: EmailDraftAttachment[]
  inReplyTo: string
  sentAt: number | null
  sentBy: string
  error: string
  deliveryUnknown: boolean
  origin: string
  sessionId: string
  updatedAt: number
}

/** The rules of a bot. Anything unreadable is the safe default: every draft waits for approval. */
export function parseRules(value: unknown): EmailDraftRules {
  const raw = asObject(value)
  const mode = text(raw.mode) as EmailDraftMode
  return { mode: MODES.has(mode) ? mode : 'approval', allowed: list(raw.allowed) }
}

export function parseEmailDraft(value: unknown): EmailDraft | null {
  const raw = asObject(value)
  const id = text(raw.id)
  const status = text(raw.status) as EmailDraftStatus
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(id) || !STATUSES.has(status)) return null
  const reply = asObject(raw.in_reply_to)
  const number = (item: unknown) => (typeof item === 'number' && Number.isFinite(item) ? item : null)
  return {
    id,
    rev: Number.isInteger(raw.rev) ? raw.rev as number : 1,
    status,
    from: text(raw.from),
    fromName: text(raw.from_name),
    signature: text(raw.signature),
    to: list(raw.to),
    cc: list(raw.cc),
    bcc: list(raw.bcc),
    subject: text(raw.subject),
    body: text(raw.body),
    attachments: (Array.isArray(raw.attachments) ? raw.attachments : []).map(asObject)
      .filter((item) => text(item.name))
      .map((item) => ({ path: text(item.path), name: text(item.name), size: number(item.size) })),
    inReplyTo: text(reply.subject) || text(reply.from) || text(reply.message_id),
    sentAt: number(raw.sent_at),
    sentBy: text(raw.sent_by),
    error: text(raw.error),
    deliveryUnknown: raw.delivery_unknown === true,
    origin: text(raw.origin),
    sessionId: text(raw.session_id),
    updatedAt: number(raw.updated_at) ?? number(raw.created_at) ?? 0,
  }
}

/** Waiting for the user, or its result is worth a line: a sent or ignored draft only stays as a note. */
export const needsAttention = (draft: EmailDraft) =>
  draft.status === 'pending' || draft.status === 'sending' || draft.status === 'failed' || draft.deliveryUnknown

/** "a@b.co, Sam <s@x.io>" → addresses; the plugin validates them again. */
export const splitAddresses = (value: string) => value.split(/[,;]/).map((item) => item.trim()).filter(Boolean)
const ADDRESS = /^(?:[^<>]*<)?[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+>?$/
export const validAddressList = (value: string) => splitAddresses(value).every((item) => ADDRESS.test(item))

export interface EmailDraftEdits { to: string; cc: string; subject: string; body: string }
export const editsOf = (draft: EmailDraft): EmailDraftEdits => ({ to: draft.to.join(', '), cc: draft.cc.join(', '), subject: draft.subject, body: draft.body })
export const sameEdits = (a: EmailDraftEdits, b: EmailDraftEdits) => a.to === b.to && a.cc === b.cc && a.subject === b.subject && a.body === b.body
export const canSendEdits = (edits: EmailDraftEdits) =>
  splitAddresses(edits.to).length > 0 && validAddressList(edits.to) && validAddressList(edits.cc) && Boolean(edits.subject.trim()) && Boolean(edits.body.trim())

export const formatSize = (bytes: number | null) =>
  bytes == null ? '' : bytes < 1024 ? `${bytes} o` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} Ko` : `${(bytes / 1024 / 1024).toFixed(1)} Mo`

export class EmailDraftsUnavailable extends Error {}
/** A refusal or a failed send. A failed send still carries the draft as it is now (status `failed`, its error). */
export class EmailDraftRefused extends Error {
  constructor(message: string, public draft: EmailDraft | null) { super(message) }
}

/** One call to the plugin. A gateway or profile without it throws `EmailDraftsUnavailable`; a refusal throws its message. */
export async function emailDraftsCall(client: HermesClient, target: { profile: string; sessionId: string }, op: string, params: Json = {}): Promise<Json> {
  let result: unknown
  try {
    result = await client.request(EMAIL_DRAFTS_METHOD, { ...params, op, profile: target.profile, session_id: target.sessionId }, 70_000)
  } catch (error) {
    if (error instanceof HermesRpcError && (error.code === -32601 || error.code === 4000 || error.data.reason === 'unknown_method' || error.data.reason === 'not_found')) {
      throw new EmailDraftsUnavailable(error.message)
    }
    throw error
  }
  const answer = asObject(result)
  if (answer.ok === false) throw new EmailDraftRefused(text(answer.error) || 'email-drafts: refused', parseEmailDraft(answer.draft))
  return answer
}

/** Same conversation: exact id, or a route (`agent:…:dm:<id>`) vs its tail (after compression). */
export const sameConversation = (draftSession: string, sessionId: string) => {
  const a = draftSession.trim()
  const b = sessionId.trim()
  if (!a || !b) return false
  return a === b || a.split(':').pop() === b.split(':').pop()
}

export async function loadChatDrafts(client: HermesClient, target: { profile: string; sessionId: string }) {
  const answer = await emailDraftsCall(client, target, 'list')
  const drafts = (Array.isArray(answer.drafts) ? answer.drafts : []).map(parseEmailDraft).filter((item): item is EmailDraft => Boolean(item))
    // This chat's drafts, plus any of the bot still waiting (a CLI or cron draft must show here).
    .filter((item) => !item.sessionId || sameConversation(item.sessionId, target.sessionId) || needsAttention(item))
    .sort((a, b) => a.updatedAt - b.updatedAt)
  return { drafts, rules: parseRules(answer.rules) }
}

/** How many drafts of this bot still need a look. Used for the sidebar mark. */
export async function countAttentionDrafts(client: HermesClient, profile: string) {
  try {
    const answer = await emailDraftsCall(client, { profile, sessionId: '' }, 'list')
    return (Array.isArray(answer.drafts) ? answer.drafts : []).map(parseEmailDraft)
      .filter((item): item is EmailDraft => Boolean(item)).filter(needsAttention).length
  } catch (error) {
    if (error instanceof EmailDraftsUnavailable) return 0
    throw error
  }
}

/**
 * The card's Envoyer: one call. The plugin saves the card's edits at the revision the card showed, then
 * sends exactly that revision once; a bot update in between is refused. A failed send comes back as the
 * draft with its error.
 */
export async function sendDraft(client: HermesClient, target: { profile: string; sessionId: string }, draft: EmailDraft, edits: EmailDraftEdits) {
  const changed = sameEdits(edits, editsOf(draft)) ? {} : { to: splitAddresses(edits.to), cc: splitAddresses(edits.cc), subject: edits.subject, body: edits.body }
  try {
    return parseEmailDraft(asObject(await emailDraftsCall(client, target, 'send', { id: draft.id, rev: draft.rev, ...changed })).draft)
  } catch (error) {
    if (error instanceof EmailDraftRefused && error.draft) return error.draft
    throw error
  }
}
