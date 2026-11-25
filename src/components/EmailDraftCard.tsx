// Cards for the email drafts a bot wrote with the `email-drafts` plugin (adapted from hermes-bot-kit, MIT).
// Only a click on Send sends; until the bot's rules change, every draft waits here.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, Mail, Paperclip } from 'lucide-react'
import type { HermesClient } from '../lib/hermes'
import {
  canSendEdits, editsOf, emailDraftsCall, EmailDraftsUnavailable, formatSize, loadChatDrafts, needsAttention, sameEdits, sendDraft, splitAddresses,
  parseEmailDraft, parseRules, type EmailDraft, type EmailDraftEdits, type EmailDraftRules,
} from '../lib/email-drafts'

interface Target { profile: string; sessionId: string }

// Unsent edits survive a bot switch (memory only, keyed by revision: a bot update shows its version).
const edits = new Map<string, EmailDraftEdits>()
const editKey = (target: Target, draft: EmailDraft) => `${target.profile}:${draft.id}:${draft.rev}`

const time = (seconds: number | null, language: string) =>
  seconds ? new Date(seconds * 1000).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' }) : ''

function RulesMenu({ draft, rules, botName, dirtyTo, onRules, onError }: {
  draft: EmailDraft; rules: EmailDraftRules; botName: string; dirtyTo: boolean
  onRules: (op: string, params?: Record<string, unknown>) => Promise<void>; onError: (message: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [manage, setManage] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) { setOpen(false); setManage(false) } }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); setManage(false) } }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape) }
  }, [open])
  const run = (op: string, params?: Record<string, unknown>) => {
    onRules(op, params).catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
    if (op !== 'unallow') setOpen(false)
  }
  const label = rules.mode === 'disabled' ? t('emailDraft.modeDisabled') : rules.mode === 'allow' ? t('emailDraft.modeAllow') : t('emailDraft.modeApproval')
  return (
    <div className="email-rules" ref={ref}>
      <button type="button" className="email-rules-button" aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(!open); setManage(false) }}>
        {label}<ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && !manage && (
        <div className="email-rules-menu" role="menu" aria-label={t('emailDraft.rulesFor', { name: botName })}>
          <button type="button" role="menuitem" disabled={dirtyTo || !draft.to.length} title={dirtyTo ? t('emailDraft.allowSaveFirst') : undefined}
            onClick={() => run('allow', { id: draft.id, rev: draft.rev, addresses: draft.to })}>
            <span>{t('emailDraft.allow', { to: draft.to.join(', ') })}</span><small>{t('emailDraft.allowHint')}</small>
          </button>
          <button type="button" role="menuitemradio" aria-checked={rules.mode === 'approval'} onClick={() => run('set_mode', { mode: 'approval' })}>
            <span>{t('emailDraft.needsApproval')}</span>{rules.mode === 'approval' && <Check size={14} aria-hidden="true" />}
          </button>
          <button type="button" role="menuitemradio" aria-checked={rules.mode === 'disabled'} onClick={() => run('set_mode', { mode: 'disabled' })}>
            <span>{t('emailDraft.disable', { name: botName })}</span>{rules.mode === 'disabled' && <Check size={14} aria-hidden="true" />}
          </button>
          <button type="button" role="menuitem" onClick={() => setManage(true)}><span>{t('emailDraft.manage')}</span></button>
        </div>
      )}
      {open && manage && (
        <div className="email-rules-menu is-manage" role="dialog" aria-label={t('emailDraft.manage')}>
          <p>{t(`emailDraft.modeLine.${rules.mode}`, { name: botName })}</p>
          {rules.allowed.length ? (
            <ul>
              {rules.allowed.map((address) => (
                <li key={address}><span>{address}</span><button type="button" onClick={() => run('unallow', { addresses: [address] })}>{t('emailDraft.remove')}</button></li>
              ))}
            </ul>
          ) : <p className="is-muted">{t('emailDraft.noneAllowed')}</p>}
          {rules.mode !== 'approval' && <button type="button" className="email-rules-reset" onClick={() => run('set_mode', { mode: 'approval' })}>{t('emailDraft.backToApproval')}</button>}
        </div>
      )}
    </div>
  )
}

function DraftCard({ draft, rules, target, botName, client, onChanged, onRules }: {
  draft: EmailDraft; rules: EmailDraftRules; target: Target; botName: string; client: HermesClient
  onChanged: (draft: EmailDraft | null) => void; onRules: (op: string, params?: Record<string, unknown>) => Promise<void>
}) {
  const { t } = useTranslation()
  const key = editKey(target, draft)
  const [value, setValue] = useState(() => edits.get(key) ?? editsOf(draft))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Exactly one action in flight: a lost answer is never repeated by the card.
  const inFlight = useRef(false)
  const change = (changes: Partial<EmailDraftEdits>) => {
    const next = { ...value, ...changes }
    if (sameEdits(next, editsOf(draft))) edits.delete(key)
    else edits.set(key, next)
    setValue(next)
  }
  const act = async (work: () => Promise<EmailDraft | null>) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const next = await work()
      edits.delete(key)
      onChanged(next)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      onChanged(null)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  const send = () => act(() => sendDraft(client, target, draft, value))
  const discard = () => act(async () => {
    const answer = await emailDraftsCall(client, target, 'discard', { id: draft.id })
    return parseEmailDraft(answer.draft)
  })
  const sending = draft.status === 'sending' && !draft.deliveryUnknown
  const failed = draft.status === 'failed'
  const locked = busy || sending || draft.deliveryUnknown
  const dirtyTo = splitAddresses(value.to).join(',').toLowerCase() !== draft.to.join(',').toLowerCase()
  const from = draft.fromName && draft.from ? `${draft.fromName} <${draft.from}>` : draft.from
  const status = draft.deliveryUnknown ? t('emailDraft.deliveryUnknown')
    : sending || busy ? t('emailDraft.sending')
    : failed ? t('emailDraft.failed')
    : draft.origin === 'cron' ? t('emailDraft.pendingCron') : t('emailDraft.pending')
  return (
    <section className={`mail-card email-draft-card${failed ? ' is-failed' : ''}`} aria-label={t('emailDraft.cardLabel', { subject: draft.subject || t('emailDraft.noSubject') })} data-draft={draft.id}>
      <header className="mail-card-title">
        <span className="mail-card-icon" aria-hidden="true"><Mail size={15} /></span>
        <span className="email-draft-title">{t('emailDraft.title', { name: botName })}</span>
        <RulesMenu draft={draft} rules={rules} botName={botName} dirtyTo={dirtyTo} onRules={onRules} onError={setError} />
      </header>
      <input className="mail-subject" aria-label={t('emailDraft.subject')} value={value.subject} readOnly={locked} placeholder={t('emailDraft.noSubject')} onChange={(event) => change({ subject: event.target.value })} />
      {from && <div className="mail-row"><span>{t('mail.from')}</span><strong>{from}</strong></div>}
      {draft.inReplyTo && <div className="mail-row"><span>{t('emailDraft.inReplyTo')}</span><strong>{draft.inReplyTo}</strong></div>}
      <label className="mail-row"><span>{t('mail.to')}</span><input aria-label={t('mail.to')} value={value.to} readOnly={locked} onChange={(event) => change({ to: event.target.value })} spellCheck={false} /></label>
      <label className="mail-row"><span>{t('mail.cc')}</span><input aria-label={t('mail.cc')} value={value.cc} readOnly={locked} onChange={(event) => change({ cc: event.target.value })} placeholder={t('mail.ccPlaceholder')} spellCheck={false} /></label>
      {draft.bcc.length > 0 && <div className="mail-row"><span>{t('emailDraft.bcc')}</span><strong>{draft.bcc.join(', ')}</strong></div>}
      <textarea className="mail-body" aria-label={t('mail.body')} value={value.body} readOnly={locked} onChange={(event) => change({ body: event.target.value })} />
      {draft.signature && <pre className="email-draft-signature" aria-label={t('emailDraft.signature')}>{draft.signature}</pre>}
      {draft.attachments.length > 0 && (
        <ul className="email-draft-files" aria-label={t('emailDraft.attachments')}>
          {draft.attachments.map((file) => (
            <li key={file.path || file.name} title={file.name}><Paperclip size={13} aria-hidden="true" /><span>{file.name}</span>{file.size != null && <small>{formatSize(file.size)}</small>}</li>
          ))}
        </ul>
      )}
      {(error || (failed && draft.error)) && <p className="email-draft-error" role="alert">{error || draft.error}</p>}
      <footer className="mail-card-footer">
        <span>{status}</span>
        {!draft.deliveryUnknown && <button type="button" disabled={locked} onClick={discard}>{t('mail.dismiss')}</button>}
        {!draft.deliveryUnknown && (
          <button type="button" className="is-primary" disabled={locked || !canSendEdits(value)} onClick={send}>
            {failed ? t('emailDraft.retry') : t('mail.send')}
          </button>
        )}
      </footer>
    </section>
  )
}

function DraftNote({ draft, language }: { draft: EmailDraft; language: string }) {
  const { t } = useTranslation()
  if (draft.status === 'discarded') return <div className="mail-note is-muted">{t('emailDraft.discarded', { subject: draft.subject })}</div>
  const key = draft.sentBy === 'allow-rule' ? 'emailDraft.sentAuto' : 'emailDraft.sent'
  return <div className="mail-note"><Check size={14} aria-hidden="true" />{t(key, { subject: draft.subject, to: draft.to.join(', '), time: time(draft.sentAt, language) })}</div>
}

/** Recently settled drafts stay as one line for this long (seconds). */
const NOTE_WINDOW_S = 30 * 60

/** The open chat's email drafts, under its messages. Renders nothing when the bot has no such plugin. */
export function EmailDraftsDock({ client, profile, sessionId, botName, running, onAttentionChange }: { client: HermesClient; profile: string; sessionId: string; botName: string; running: boolean; onAttentionChange?: (count: number) => void }) {
  const { i18n } = useTranslation()
  const [drafts, setDrafts] = useState<EmailDraft[]>([])
  const [rules, setRules] = useState<EmailDraftRules>({ mode: 'approval', allowed: [] })
  const [available, setAvailable] = useState(true)
  const target = { profile, sessionId }
  const targetKey = `${profile}\n${sessionId}`
  const generation = useRef(0)
  const attentionRef = useRef(onAttentionChange)
  attentionRef.current = onAttentionChange
  const reload = useCallback(async () => {
    if (!profile || !sessionId) return
    const mine = ++generation.current
    try {
      const loaded = await loadChatDrafts(client, { profile, sessionId })
      if (mine !== generation.current) return
      setAvailable(true)
      setDrafts(loaded.drafts)
      setRules(loaded.rules)
      attentionRef.current?.(loaded.drafts.filter(needsAttention).length)
    } catch (error) {
      if (mine !== generation.current) return
      if (error instanceof EmailDraftsUnavailable) { setAvailable(false); setDrafts([]) }
    }
  }, [client, profile, sessionId])
  useEffect(() => { setDrafts([]); setAvailable(true); void reload() }, [targetKey, reload])
  // A turn that ends may have written or updated a draft.
  const wasRunning = useRef(running)
  useEffect(() => {
    if (wasRunning.current && !running) void reload()
    wasRunning.current = running
  }, [running, reload])
  // A draft being sent elsewhere (another window) settles on its own: look again while one is in flight.
  const anySending = drafts.some((draft) => draft.status === 'sending' && !draft.deliveryUnknown)
  useEffect(() => {
    if (!anySending) return
    const timer = window.setInterval(() => void reload(), 4_000)
    return () => window.clearInterval(timer)
  }, [anySending, reload])
  if (!available || !drafts.length) return null
  const now = Date.now() / 1000
  const shown = drafts.filter((draft) => needsAttention(draft) || now - draft.updatedAt < NOTE_WINDOW_S || (draft.sentAt && now - draft.sentAt < NOTE_WINDOW_S))
  if (!shown.length) return null
  const onRules = async (op: string, params: Record<string, unknown> = {}) => {
    const answer = await emailDraftsCall(client, target, op, params)
    setRules(parseRules(answer.rules))
    void reload()
  }
  return (
    <div className="email-drafts" aria-label={i18n.t('emailDraft.dockLabel')}>
      {shown.map((draft) => needsAttention(draft)
        ? <DraftCard key={`${draft.id}:${draft.rev}`} draft={draft} rules={rules} target={target} botName={botName} client={client}
            onChanged={(next) => { if (next) setDrafts((list) => list.map((item) => (item.id === next.id ? next : item))); void reload() }}
            onRules={onRules} />
        : <DraftNote key={draft.id} draft={draft} language={i18n.language} />)}
    </div>
  )
}
