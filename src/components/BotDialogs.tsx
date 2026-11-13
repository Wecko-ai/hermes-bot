import { useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { SquarePen, Trash2 } from 'lucide-react'
import type { Bot } from '../types'
import { botActionError } from '../lib/bot-actions'
import './BotDialogs.css'

/** Longest display name accepted: the roster row and the chat header stay readable. */
const MAX_NAME = 64

function BotSheet({ title, icon, danger, busy, children, onCancel, onSubmit }: {
  title: string
  icon: ReactNode
  danger?: boolean
  busy: boolean
  children: ReactNode
  onCancel: () => void
  onSubmit: (event: FormEvent) => void
}) {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !busy) {
      event.stopPropagation()
      onCancel()
    }
  }
  return (
    <div className="request-scrim bot-sheet-scrim" role="presentation" onKeyDown={onKeyDown} onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel() }}>
      <form className={`request-sheet bot-sheet${danger ? ' is-danger' : ''}`} role={danger ? 'alertdialog' : 'dialog'} aria-modal="true" aria-label={title} autoComplete="off" onSubmit={onSubmit}>
        <div className="request-icon" aria-hidden="true">{icon}</div>
        <h2>{title}</h2>
        {children}
      </form>
    </div>
  )
}

/** Rename: the display name only, written to the bot's card. The Hermes profile keeps its name. */
export function RenameBotDialog({ bot, onRename, onClose }: { bot: Bot; onRename: (title: string) => Promise<void>; onClose: () => void }) {
  const { t } = useTranslation()
  const [title, setTitle] = useState(bot.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const clean = title.trim()
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!clean || busy) return
    if (clean === bot.name) { onClose(); return }
    setBusy(true)
    setError('')
    try {
      await onRename(clean)
      onClose()
    } catch (failure) {
      setError(botActionError(failure))
      setBusy(false)
    }
  }
  return (
    <BotSheet title={t('botMenu.renameTitle', { name: bot.name })} icon={<SquarePen size={18} />} busy={busy} onCancel={onClose} onSubmit={submit}>
      <label>
        {t('botMenu.renameLabel')}
        <input value={title} maxLength={MAX_NAME} autoFocus onFocus={(event) => event.currentTarget.select()} onChange={(event) => setTitle(event.target.value)} disabled={busy} spellCheck={false} />
      </label>
      <p className="request-note">{t('botMenu.renameHint', { slug: bot.slug })}</p>
      {error && <p className="request-error" role="alert">{error}</p>}
      <div className="request-actions">
        <button type="button" onClick={onClose} disabled={busy}>{t('botMenu.cancel')}</button>
        <button type="submit" className="is-primary" disabled={!clean || busy}>{busy ? t('botMenu.saving') : t('botMenu.renameSubmit')}</button>
      </div>
    </BotSheet>
  )
}

/**
 * Delete, as this app can do it: the bot leaves the roster, its Hermes profile stays on the machine. The text says
 * exactly that, and how to erase the profile for good.
 */
export function DeleteBotDialog({ bot, onDelete, onClose }: { bot: Bot; onDelete: () => Promise<void>; onClose: () => void }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await onDelete()
      onClose()
    } catch (failure) {
      setError(botActionError(failure))
      setBusy(false)
    }
  }
  return (
    <BotSheet title={t('botMenu.deleteTitle', { name: bot.name })} icon={<Trash2 size={18} />} danger busy={busy} onCancel={onClose} onSubmit={submit}>
      <p>{t('botMenu.deleteBody', { name: bot.name, slug: bot.slug })}</p>
      <p>{t('botMenu.deleteOthers')}</p>
      <p className="bot-sheet-command-label">{t('botMenu.deleteForGood')}</p>
      <code className="bot-sheet-command">hermes profile delete {bot.slug}</code>
      {error && <p className="request-error" role="alert">{error}</p>}
      <div className="request-actions">
        <button type="button" onClick={onClose} disabled={busy} autoFocus>{t('botMenu.cancel')}</button>
        <button type="submit" className="is-danger" disabled={busy}>{busy ? t('botMenu.deleting') : t('botMenu.deleteSubmit')}</button>
      </div>
    </BotSheet>
  )
}
