import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import type { ChatMessage } from '../types'

/**
 * Steps of one turn. While it runs, only the latest line is shown (no box, no stack).
 * Once the reply is in, the steps start collapsed and stay collapsed until this button
 * is clicked. That open/closed choice lives only in this component: a finished turn
 * forces it shut, and nothing writes it to storage, so a reload or a new message
 * starts collapsed again.
 */
export function ProgressTurn({ progress, answer, collapsed, renderAnswer }: {
  progress: ChatMessage[]
  answer?: ChatMessage
  collapsed: boolean
  renderAnswer: (message: ChatMessage) => React.ReactNode
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [wasCollapsed, setWasCollapsed] = useState(collapsed)
  if (wasCollapsed !== collapsed) {
    setWasCollapsed(collapsed)
    if (collapsed) setOpen(false)
  }
  const latest = progress.at(-1)
  return (
    <div className={`progress-turn ${collapsed ? 'is-collapsed' : 'is-live'}`}>
      {progress.length > 0 && (collapsed ? (
        <>
          <button type="button" className="progress-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            <ChevronDown size={13} className={open ? 'is-open' : ''} aria-hidden="true" />
            {t('progress.toggle', { count: progress.length })}
          </button>
          {open && (
            <div className="progress-stack">
              {progress.map((item) => (
                <p key={item.id} className="progress-line">{item.content}</p>
              ))}
            </div>
          )}
        </>
      ) : latest && (
        <p className="progress-live">{latest.content}</p>
      ))}
      {answer && <div className="progress-answer">{renderAnswer(answer)}</div>}
    </div>
  )
}
