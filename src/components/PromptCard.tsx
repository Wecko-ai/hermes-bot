import { useState, type FormEvent } from 'react'
import { ArrowUp, Check, MessageCircleQuestion, ShieldCheck } from 'lucide-react'
import type { PendingPrompt } from '../lib/hermes'
import { CHOICE_LABELS } from './ServerRequestDialog'

interface PromptCardProps {
  prompt: PendingPrompt
  botName: string
  /** Rejette si la gateway refuse : la carte reste alors ouverte. */
  onAnswer: (prompt: PendingPrompt, answer: string) => Promise<void>
}

/**
 * Question (`clarify`) ou accord (`approval`) d’un bot en plein tour, posée au-dessus du champ de saisie.
 * Le bot reste bloqué tant que l’utilisateur ne répond pas : la carte ne se ferme que sur `*.settled`.
 */
export function PromptCard({ prompt, botName, onAnswer }: PromptCardProps) {
  const [selected, setSelected] = useState<string[]>([])
  const [other, setOther] = useState('')
  const [sending, setSending] = useState(false)

  const send = async (answer: string) => {
    if (sending || !answer.trim()) return
    setSending(true)
    try {
      await onAnswer(prompt, answer)
    } catch {
      // Le parent affiche l’erreur ; la carte reste pour réessayer.
    } finally {
      setSending(false)
    }
  }

  if (prompt.kind === 'approval') {
    const choices = prompt.choices.length ? prompt.choices : ['once', 'deny']
    return (
      <section className="prompt-card" aria-label={`${botName} demande ton accord`}>
        <div className="prompt-card-title"><span className="prompt-card-icon"><ShieldCheck size={15} /></span><strong>{botName} demande ton accord</strong></div>
        <p className="prompt-card-question">{prompt.description || 'Cette action demande une approbation.'}</p>
        {prompt.command && <pre className="request-command">{prompt.command}</pre>}
        <div className="prompt-card-actions">
          {[...choices].reverse().map((choice) => (
            <button key={choice} type="button" className={choice === 'once' ? 'is-primary' : ''} disabled={sending} onClick={() => void send(choice)}>{CHOICE_LABELS[choice] || choice}</button>
          ))}
        </div>
      </section>
    )
  }

  const toggle = (choice: string) => setSelected((items) => items.includes(choice) ? items.filter((item) => item !== choice) : [...items, choice])
  const submitOther = (event: FormEvent) => {
    event.preventDefault()
    void send(other.trim())
  }
  return (
    <section className="prompt-card" aria-label={`${botName} te pose une question`}>
      <div className="prompt-card-title"><span className="prompt-card-icon"><MessageCircleQuestion size={15} /></span><strong>{botName} te pose une question</strong></div>
      <p className="prompt-card-question">{prompt.question || 'Le bot attend ta réponse.'}</p>
      {prompt.choices.length > 0 && (
        <div className="prompt-card-choices" role={prompt.multiSelect ? 'group' : undefined}>
          {prompt.choices.map((choice) => {
            const on = selected.includes(choice)
            return prompt.multiSelect ? (
              <button key={choice} type="button" className={`prompt-choice ${on ? 'is-selected' : ''}`} aria-pressed={on} disabled={sending} onClick={() => toggle(choice)}>
                <span className="prompt-choice-check" aria-hidden="true">{on && <Check size={12} />}</span>{choice}
              </button>
            ) : (
              <button key={choice} type="button" className="prompt-choice" disabled={sending} onClick={() => void send(choice)}>{choice}</button>
            )
          })}
        </div>
      )}
      {prompt.multiSelect && prompt.choices.length > 0 && (
        <div className="prompt-card-actions">
          <button type="button" className="is-primary" disabled={sending || selected.length === 0} onClick={() => void send(JSON.stringify(selected))}>
            Valider{selected.length ? ` (${selected.length})` : ''}
          </button>
        </div>
      )}
      <form className="prompt-card-other" onSubmit={submitOther}>
        <input
          value={other}
          onChange={(event) => setOther(event.target.value)}
          placeholder={prompt.choices.length ? 'Autre réponse…' : 'Ta réponse…'}
          aria-label={`Réponse libre à ${botName}`}
          disabled={sending}
          autoFocus={prompt.choices.length === 0}
        />
        <button type="submit" aria-label="Envoyer la réponse" disabled={sending || !other.trim()}><ArrowUp size={15} /></button>
      </form>
    </section>
  )
}
