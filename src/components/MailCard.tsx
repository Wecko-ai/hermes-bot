import { createContext, useContext, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Mail } from 'lucide-react'
import { approvedMailPrompt, canSendMail, parseMailBlock, type MailDraft } from '../lib/mail'

interface MailContextValue {
  profile: string
  running: boolean
  approved: Set<string>
  onApprove: (prompt: string) => void
}

export const MailContext = createContext<MailContextValue | null>(null)

// An edit in progress survives a bot switch. Nothing is written to disk.
const edits = new Map<string, MailDraft>()
const DISCARDED_KEY = 'hermesbot-mail-discarded'

function readDiscarded(): string[] {
  try { return JSON.parse(localStorage.getItem(DISCARDED_KEY) || '[]') } catch { return [] }
}

function writeDiscarded(keys: string[]) {
  try { localStorage.setItem(DISCARDED_KEY, JSON.stringify(keys.slice(-200))) } catch { /* storage unavailable */ }
}

function MailCard({ draft, context }: { draft: MailDraft; context: MailContextValue }) {
  const { t } = useTranslation()
  const key = `${context.profile}:${draft.id}`
  const [value, setValue] = useState(() => edits.get(key) ?? draft)
  const [discarded, setDiscarded] = useState(() => readDiscarded().includes(key))
  const [busy, setBusy] = useState(false)
  const change = (changes: Partial<MailDraft>) => {
    const next = { ...value, ...changes }
    edits.set(key, next)
    setValue(next)
  }
  const discard = (state: boolean) => {
    setDiscarded(state)
    writeDiscarded(state ? [...readDiscarded(), key] : readDiscarded().filter((item) => item !== key))
    edits.delete(key)
  }
  const send = async () => {
    setBusy(true)
    try {
      context.onApprove(await approvedMailPrompt(value))
      edits.delete(key)
    } finally {
      setBusy(false)
    }
  }

  if (context.approved.has(draft.id)) {
    return <div className="mail-note"><Check size={14} />{t('mail.approved', { subject: draft.subject })}</div>
  }
  if (discarded) {
    return <div className="mail-note is-muted">{t('mail.discarded', { subject: draft.subject })}<button type="button" onClick={() => discard(false)}>{t('mail.restore')}</button></div>
  }
  return (
    <section className="mail-card" aria-label={t('mail.cardLabel', { subject: draft.subject })}>
      <header className="mail-card-title"><span className="mail-card-icon" aria-hidden="true"><Mail size={15} /></span>{t('mail.title')}</header>
      <input className="mail-subject" aria-label={t('mail.subject')} value={value.subject} onChange={(event) => change({ subject: event.target.value })} />
      {value.from && <div className="mail-row"><span>{t('mail.from')}</span><strong>{value.from}</strong></div>}
      {value.replyLabel && <div className="mail-row"><span>{t('mail.replyTo')}</span><strong>{value.replyLabel}</strong></div>}
      <label className="mail-row"><span>{t('mail.to')}</span><input aria-label={t('mail.to')} value={value.to} onChange={(event) => change({ to: event.target.value })} spellCheck={false} /></label>
      <label className="mail-row"><span>{t('mail.cc')}</span><input aria-label={t('mail.cc')} value={value.cc} onChange={(event) => change({ cc: event.target.value })} placeholder={t('mail.ccPlaceholder')} spellCheck={false} /></label>
      <textarea className="mail-body" aria-label={t('mail.body')} value={value.body} onChange={(event) => change({ body: event.target.value })} />
      <footer className="mail-card-footer">
        <span>{t('mail.pending')}</span>
        <button type="button" onClick={() => discard(true)}>{t('mail.dismiss')}</button>
        <button type="button" className="is-primary" disabled={busy || context.running || !canSendMail(value)} title={context.running ? t('mail.botBusy') : undefined} onClick={send}>{t('mail.send')}</button>
      </footer>
    </section>
  )
}

/** A `hermes-mail` block of the thread: a card to approve, or a plain note once approved. */
export function MailBlock({ source, approvedBlock, streaming }: { source: string; approvedBlock: boolean; streaming: boolean }) {
  const { t } = useTranslation()
  const context = useContext(MailContext)
  if (streaming) return <div className="mail-note is-muted">{t('mail.drafting')}</div>
  const draft = parseMailBlock(source)
  // An unreadable block stays visible as is: nothing the bot wrote is hidden.
  if (!draft || !context) return <pre><code>{source}</code></pre>
  if (approvedBlock) return <div className="mail-note"><Check size={14} />{t('mail.sentTo', { subject: draft.subject, to: draft.to })}</div>
  return <MailCard draft={draft} context={context} />
}
