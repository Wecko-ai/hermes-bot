import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, History, SquarePen, Trash2 } from 'lucide-react'
import type { LocalHistory } from '../lib/local-chat'
import { i18n } from '../i18n'

interface LocalHistoryMenuProps {
  history: LocalHistory | null
  current: string
  disabled: boolean
  onOpen: () => void
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
}

function when(iso: string) {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  const sameDay = new Date(at).toDateString() === new Date().toDateString()
  return new Intl.DateTimeFormat(i18n.language, sameDay ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(at)
}

/** Saved conversations of the local chat: reopen one, start a new one, delete one (second click confirms). */
export function LocalHistoryMenu({ history, current, disabled, onOpen, onSelect, onNew, onDelete }: LocalHistoryMenuProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const conversations = history?.conversations ?? []

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    listRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  useEffect(() => { if (!open) setConfirming('') }, [open])

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      rootRef.current?.querySelector<HTMLButtonElement>('.local-history-button')?.focus()
      return
    }
    if (!open || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
    event.preventDefault()
    const rows = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('.local-model-row') ?? [])]
    const index = rows.indexOf(document.activeElement as HTMLButtonElement)
    rows[(index + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus()
  }

  return (
    <div className="local-model-menu" ref={rootRef} onKeyDown={keyDown}>
      <button type="button" className="plain-icon local-history-button" aria-label={t('localChat.history')} title={t('localChat.history')} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => { if (!open) onOpen(); setOpen(!open) }}>
        <History size={16} />
      </button>
      {open && (
        <div className="local-model-popover local-history-popover" role="menu" aria-label={t('localChat.historyTitle')} ref={listRef}>
          <button type="button" role="menuitem" className="local-model-row local-history-new" onClick={() => { setOpen(false); onNew() }}>
            <span className="local-model-row-check" aria-hidden="true"><SquarePen size={14} /></span>
            <span className="local-model-row-name">{t('localChat.newConversation')}</span>
          </button>
          <p className="local-model-popover-title">{t('localChat.historyTitle')}</p>
          {history && !history.persistent && <p className="local-model-empty">{t('localChat.historyMemoryOnly')}</p>}
          {history && !history.readable && <p className="local-model-empty is-warning">{t('localChat.historyUnreadable')}</p>}
          {conversations.length === 0 && history?.readable !== false && <p className="local-model-empty">{t('localChat.noHistory')}</p>}
          {conversations.map((conversation) => (
            <div key={conversation.id} className="local-history-item" role="none">
              <button type="button" role="menuitemradio" aria-checked={conversation.id === current} className="local-model-row" onClick={() => { setOpen(false); if (conversation.id !== current) onSelect(conversation.id) }}>
                <span className="local-model-row-check" aria-hidden="true">{conversation.id === current && <Check size={14} />}</span>
                <span className="local-model-row-text">
                  <span className="local-model-row-name">{conversation.title || t('localChat.untitled')}</span>
                  <span className="local-model-row-facts">{[when(conversation.updatedAt), conversation.model, t('localChat.messages', { count: conversation.count })].filter(Boolean).join(' · ')}</span>
                </span>
              </button>
              <button
                type="button"
                className={`local-history-delete ${confirming === conversation.id ? 'is-confirming' : ''}`}
                aria-label={confirming === conversation.id ? t('localChat.confirmDelete') : t('localChat.deleteConversation')}
                title={t('localChat.deleteConversation')}
                onClick={() => {
                  if (confirming !== conversation.id) return setConfirming(conversation.id)
                  setConfirming('')
                  onDelete(conversation.id)
                }}
              >
                {confirming === conversation.id ? <span>{t('localChat.confirmDelete')}</span> : <Trash2 size={14} />}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
