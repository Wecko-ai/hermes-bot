import { createContext, useContext, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Send } from 'lucide-react'
import { approvalAccepted } from '../lib/approval'
import { approvedDraftPrompt, canSendDraft, parseDraftBlock, type DraftChannel, type MessageDraft } from '../lib/draft'
import type { ChatMessage } from '../types'

interface DraftContextValue {
  profile: string
  running: boolean
  approved: Set<string>
  onApprove: (prompt: string) => Promise<boolean | void> | boolean | void
}

export const DraftContext = createContext<DraftContextValue | null>(null)

const edits = new Map<string, MessageDraft>()
const DISCARDED_KEY = 'hermesbot-draft-discarded'
const CHANNELS: DraftChannel[] = ['x', 'slack', 'telegram']

function readDiscarded(): string[] {
  try { return JSON.parse(localStorage.getItem(DISCARDED_KEY) || '[]') } catch { return [] }
}

function writeDiscarded(keys: string[]) {
  try { localStorage.setItem(DISCARDED_KEY, JSON.stringify(keys.slice(-200))) } catch { /* storage unavailable */ }
}

function DraftEditor({ draft, context }: { draft: MessageDraft; context: DraftContextValue }) {
  const { t } = useTranslation()
  const key = `${context.profile}:${draft.id}`
  const [value, setValue] = useState(() => edits.get(key) ?? draft)
  const [discarded, setDiscarded] = useState(() => readDiscarded().includes(key))
  const [busy, setBusy] = useState(false)
  const change = (changes: Partial<MessageDraft>) => {
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
      const accepted = await approvalAccepted(context.onApprove(await approvedDraftPrompt(value)))
      if (accepted) edits.delete(key)
    } finally {
      setBusy(false)
    }
  }

  if (context.approved.has(draft.id)) {
    return <div className="draft-note"><Check size={14} />{t('draft.approved', { channel: t(`draft.channels.${value.channel}`), recipient: value.recipient })}</div>
  }
  if (discarded) {
    return <div className="draft-note is-muted">{t('draft.discarded', { channel: t(`draft.channels.${value.channel}`) })}<button type="button" onClick={() => discard(false)}>{t('draft.restore')}</button></div>
  }
  return (
    <section className="draft-card mail-card" aria-label={t('draft.cardLabel', { channel: t(`draft.channels.${value.channel}`) })}>
      <header className="mail-card-title"><span className="mail-card-icon" aria-hidden="true"><Send size={15} /></span>{t('draft.title')}</header>
      <label className="mail-row"><span>{t('draft.channel')}</span>
        <select aria-label={t('draft.channel')} value={value.channel} onChange={(event) => change({ channel: event.target.value as DraftChannel })}>
          {CHANNELS.map((channel) => <option key={channel} value={channel}>{t(`draft.channels.${channel}`)}</option>)}
        </select>
      </label>
      <label className="mail-row"><span>{t('draft.recipient')}</span><input aria-label={t('draft.recipient')} value={value.recipient} onChange={(event) => change({ recipient: event.target.value })} spellCheck={false} /></label>
      <label className="mail-row"><span>{t('draft.thread')}</span><input aria-label={t('draft.thread')} value={value.thread} onChange={(event) => change({ thread: event.target.value })} placeholder={t('draft.threadPlaceholder')} spellCheck={false} /></label>
      <label className="mail-row"><span>{t('draft.attachments')}</span><input aria-label={t('draft.attachments')} value={value.attachments} onChange={(event) => change({ attachments: event.target.value })} placeholder={t('draft.attachmentsPlaceholder')} spellCheck={false} /></label>
      <textarea className="mail-body" aria-label={t('draft.text')} value={value.text} onChange={(event) => change({ text: event.target.value })} />
      <footer className="mail-card-footer">
        <span>{t('draft.pending')}</span>
        <button type="button" onClick={() => discard(true)}>{t('draft.dismiss')}</button>
        <button type="button" className="is-primary" disabled={busy || context.running || !canSendDraft(value)} title={context.running ? t('draft.botBusy') : undefined} onClick={send}>{t('draft.send')}</button>
      </footer>
    </section>
  )
}

export function DraftBlock({ source, approvedBlock, streaming, role }: { source: string; approvedBlock: boolean; streaming: boolean; role?: ChatMessage['role'] }) {
  const { t } = useTranslation()
  const context = useContext(DraftContext)
  if (streaming) return <div className="draft-note is-muted">{t('draft.drafting')}</div>
  const draft = parseDraftBlock(source)
  if (!draft || !context) return <pre><code>{source}</code></pre>
  if (approvedBlock) {
    if (role !== 'user') return <pre><code>{source}</code></pre>
    return <div className="draft-note"><Check size={14} />{t('draft.sent', { channel: t(`draft.channels.${draft.channel}`), recipient: draft.recipient })}</div>
  }
  return <DraftEditor draft={draft} context={context} />
}