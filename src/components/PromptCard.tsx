import { useTranslation } from 'react-i18next'
import { useState, type FormEvent } from 'react'
import { ArrowUp, Check, MessageCircleQuestion, ShieldCheck } from 'lucide-react'
import type { PendingPrompt } from '../lib/hermes'
import { CHOICE_LABELS } from './ServerRequestDialog'

interface PromptCardProps {
  prompt: PendingPrompt
  botName: string
  /** Rejects if the gateway refuses: the card then stays open. */
  onAnswer: (prompt: PendingPrompt, answer: string) => Promise<void>
}

/**
 * Question (`clarify`) or approval (`approval`) from a bot mid-turn, shown above the input field.
 * The bot stays blocked until the user answers: the card only closes on `*.settled`.
 */
export function PromptCard({ prompt, botName, onAnswer }: PromptCardProps) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<string[]>([])
  const [other, setOther] = useState('')
  const [sending, setSending] = useState(false)

  const send = async (answer: string) => {
    if (sending || !answer.trim()) return
    setSending(true)
    try {
      await onAnswer(prompt, answer)
    } catch {
      // The parent shows the error; the card stays so the user can retry.
    } finally {
      setSending(false)
    }
  }

  if (prompt.kind === 'approval') {
    const choices = prompt.choices.length ? prompt.choices : ['once', 'deny']
    return (
      <section className="prompt-card" aria-label={t('prompt.approvalTitle', { name: botName })}>
        <div className="prompt-card-title"><span className="prompt-card-icon"><ShieldCheck size={15} /></span><strong>{t('prompt.approvalTitle', { name: botName })}</strong></div>
        <p className="prompt-card-question">{prompt.description || t('prompt.approvalDefault')}</p>
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
    <section className="prompt-card" aria-label={t('prompt.questionTitle', { name: botName })}>
      <div className="prompt-card-title"><span className="prompt-card-icon"><MessageCircleQuestion size={15} /></span><strong>{t('prompt.questionTitle', { name: botName })}</strong></div>
      <p className="prompt-card-question">{prompt.question || t('prompt.questionDefault')}</p>
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
            {selected.length ? t('prompt.confirmCount', { count: selected.length }) : t('prompt.confirm')}
          </button>
        </div>
      )}
      <form className="prompt-card-other" onSubmit={submitOther}>
        <input
          value={other}
          onChange={(event) => setOther(event.target.value)}
          placeholder={prompt.choices.length ? t('prompt.otherAnswer') : t('prompt.yourAnswer')}
          aria-label={t('prompt.freeAnswer', { name: botName })}
          disabled={sending}
          autoFocus={prompt.choices.length === 0}
        />
        <button type="submit" aria-label={t('prompt.sendAnswer')} disabled={sending || !other.trim()}><ArrowUp size={15} /></button>
      </form>
    </section>
  )
}
