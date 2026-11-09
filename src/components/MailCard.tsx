import { createContext, useContext, useState } from 'react'
import { Check, Mail } from 'lucide-react'
import { approvedMailPrompt, canSendMail, parseMailBlock, type MailDraft } from '../lib/mail'

interface MailContextValue {
  profile: string
  running: boolean
  approved: Set<string>
  onApprove: (prompt: string) => void
}

export const MailContext = createContext<MailContextValue | null>(null)

// Une correction en cours survit à un changement de bot. Rien n’est écrit sur disque.
const edits = new Map<string, MailDraft>()
const DISCARDED_KEY = 'hermesbot-mail-discarded'

function readDiscarded(): string[] {
  try { return JSON.parse(localStorage.getItem(DISCARDED_KEY) || '[]') } catch { return [] }
}

function writeDiscarded(keys: string[]) {
  try { localStorage.setItem(DISCARDED_KEY, JSON.stringify(keys.slice(-200))) } catch { /* storage indisponible */ }
}

function MailCard({ draft, context }: { draft: MailDraft; context: MailContextValue }) {
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
    return <div className="mail-note"><Check size={14} />Mail approuvé : {draft.subject}</div>
  }
  if (discarded) {
    return <div className="mail-note is-muted">Brouillon écarté : {draft.subject}<button type="button" onClick={() => discard(false)}>Rétablir</button></div>
  }
  return (
    <section className="mail-card" aria-label={`Brouillon de mail : ${draft.subject}`}>
      <header className="mail-card-title"><span className="mail-card-icon" aria-hidden="true"><Mail size={15} /></span>Mail</header>
      <input className="mail-subject" aria-label="Objet" value={value.subject} onChange={(event) => change({ subject: event.target.value })} />
      {value.from && <div className="mail-row"><span>De</span><strong>{value.from}</strong></div>}
      {value.replyLabel && <div className="mail-row"><span>En réponse à</span><strong>{value.replyLabel}</strong></div>}
      <label className="mail-row"><span>À</span><input aria-label="À" value={value.to} onChange={(event) => change({ to: event.target.value })} spellCheck={false} /></label>
      <label className="mail-row"><span>Cc</span><input aria-label="Cc" value={value.cc} onChange={(event) => change({ cc: event.target.value })} placeholder="nom@exemple.com" spellCheck={false} /></label>
      <textarea className="mail-body" aria-label="Corps du mail" value={value.body} onChange={(event) => change({ body: event.target.value })} />
      <footer className="mail-card-footer">
        <span>À approuver</span>
        <button type="button" onClick={() => discard(true)}>Ignorer</button>
        <button type="button" className="is-primary" disabled={busy || context.running || !canSendMail(value)} title={context.running ? 'Le bot travaille encore.' : undefined} onClick={send}>Envoyer</button>
      </footer>
    </section>
  )
}

/** Un bloc `hermes-mail` du fil : carte à valider, ou simple note une fois approuvé. */
export function MailBlock({ source, approvedBlock, streaming }: { source: string; approvedBlock: boolean; streaming: boolean }) {
  const context = useContext(MailContext)
  if (streaming) return <div className="mail-note is-muted">Brouillon de mail en cours…</div>
  const draft = parseMailBlock(source)
  // Un bloc illisible reste visible tel quel : rien de ce que le bot a écrit n’est caché.
  if (!draft || !context) return <pre><code>{source}</code></pre>
  if (approvedBlock) return <div className="mail-note"><Check size={14} />{draft.subject}, à {draft.to}</div>
  return <MailCard draft={draft} context={context} />
}
