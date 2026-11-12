import { useContext, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, MessageCircleQuestion } from 'lucide-react'
import { MailContext } from './MailCard'
import { answersPrompt, hasAnswer, type OpenQuestions } from '../lib/questions'

// Answers being written are kept on this Mac (localStorage), so a restart loses nothing.
const DRAFTS_KEY = 'hermesbot-question-drafts'
const SENT_KEY = 'hermesbot-question-sent'

function readMap(key: string): Record<string, string[]> {
  try { return JSON.parse(localStorage.getItem(key) || '{}') || {} } catch { return {} }
}

function writeEntry(key: string, id: string, value: string[] | null) {
  try {
    const map = readMap(key)
    if (value) map[id] = value
    else delete map[id]
    const kept = Object.keys(map).slice(-200)
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(kept.map((item) => [item, map[item]]))))
  } catch { /* storage unavailable */ }
}

/** The "open questions" of a reply, with one field per question and a button that sends the answers. */
export function QuestionsCard({ id, block }: { id: string; block: OpenQuestions }) {
  const { t } = useTranslation()
  const context = useContext(MailContext)
  const key = `${context?.profile ?? ''}:${id}`
  const empty = () => block.questions.map(() => '')
  const [answers, setAnswers] = useState<string[]>(() => {
    const saved = readMap(DRAFTS_KEY)[key]
    return saved?.length === block.questions.length ? saved : empty()
  })
  const [sent, setSent] = useState(() => Boolean(readMap(SENT_KEY)[key]))

  const change = (index: number, value: string) => {
    const next = answers.map((answer, position) => (position === index ? value : answer))
    setAnswers(next)
    writeEntry(DRAFTS_KEY, key, hasAnswer(next) ? next : null)
  }
  const send = () => {
    if (!context || !hasAnswer(answers)) return
    context.onApprove(answersPrompt(t('questions.intro'), block.questions, answers))
    writeEntry(SENT_KEY, key, answers)
    writeEntry(DRAFTS_KEY, key, null)
    setSent(true)
  }

  if (sent) {
    const count = readMap(SENT_KEY)[key]?.filter((answer) => answer.trim()).length ?? 0
    return (
      <div className="mail-note">
        <Check size={14} />{t('questions.sent', { count })}
        <button type="button" onClick={() => { writeEntry(SENT_KEY, key, null); setSent(false) }}>{t('questions.again')}</button>
      </div>
    )
  }
  const filled = answers.filter((answer) => answer.trim()).length
  return (
    <section className="questions-card" aria-label={block.heading}>
      <header className="mail-card-title"><span className="mail-card-icon" aria-hidden="true"><MessageCircleQuestion size={15} /></span>{block.heading}</header>
      <ol className="questions-list">
        {block.questions.map((question, index) => (
          <li key={index}>
            <label>
              <span className="questions-text">{question}</span>
              <textarea
                className="questions-answer"
                rows={1}
                value={answers[index] ?? ''}
                placeholder={t('questions.placeholder')}
                onChange={(event) => change(index, event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); send() }
                }}
              />
            </label>
          </li>
        ))}
      </ol>
      <footer className="mail-card-footer">
        <span>{t('questions.progress', { filled, total: block.questions.length })}</span>
        <button
          type="button"
          className="is-primary"
          disabled={!context || context.running || !hasAnswer(answers)}
          title={context?.running ? t('mail.botBusy') : t('questions.shortcut')}
          onClick={send}
        >{t('questions.send')}</button>
      </footer>
    </section>
  )
}
