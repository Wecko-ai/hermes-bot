import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import type { ChatMessage } from '../types'

export function ProgressTurn({ progress, answer, collapsed, renderAnswer }: {
  progress: ChatMessage[]
  answer?: ChatMessage
  collapsed: boolean
  renderAnswer: (message: ChatMessage) => React.ReactNode
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(!collapsed)
  const showToggle = collapsed && progress.length > 0
  return (
    <div className={`progress-turn ${collapsed ? 'is-collapsed' : 'is-live'}`}>
      {progress.length > 0 && (
        <>
          {showToggle && (
            <button type="button" className="progress-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
              <ChevronDown size={13} className={open ? 'is-open' : ''} aria-hidden="true" />
              {t('progress.toggle', { count: progress.length })}
            </button>
          )}
          {(!showToggle || open) && (
            <div className="progress-stack">
              {progress.map((item) => (
                <p key={item.id} className="progress-bubble" title={item.content}>{item.content}</p>
              ))}
            </div>
          )}
        </>
      )}
      {answer && <div className="progress-answer">{renderAnswer(answer)}</div>}
    </div>
  )
}