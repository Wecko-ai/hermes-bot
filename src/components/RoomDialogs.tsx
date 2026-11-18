import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { SquarePen, Trash2 } from 'lucide-react'
import type { Room } from '../lib/rooms'
import { ROOM_NAME_MAX } from '../lib/rooms'
import { BotSheet } from './BotDialogs'
import './BotDialogs.css'

/** Rename: the room's name only, written to the room log by Hermes for every member. */
export function RenameRoomDialog({ room, onRename, onClose }: { room: Room; onRename: (name: string) => Promise<void>; onClose: () => void }) {
  const { t } = useTranslation()
  const [name, setName] = useState(room.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const clean = name.trim()
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!clean || busy) return
    if (clean === room.name) { onClose(); return }
    setBusy(true)
    setError('')
    try {
      await onRename(clean)
      onClose()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      setBusy(false)
    }
  }
  return (
    <BotSheet title={t('room.menu.renameTitle', { name: room.name })} icon={<SquarePen size={18} />} busy={busy} onCancel={onClose} onSubmit={submit}>
      <label>
        {t('room.menu.renameLabel')}
        <input value={name} maxLength={ROOM_NAME_MAX} autoFocus onFocus={(event) => event.currentTarget.select()} onChange={(event) => setName(event.target.value)} disabled={busy} spellCheck={false} />
      </label>
      <p className="request-note">{t('room.menu.renameHint')}</p>
      {error && <p className="request-error" role="alert">{error}</p>}
      <div className="request-actions">
        <button type="button" onClick={onClose} disabled={busy}>{t('botMenu.cancel')}</button>
        <button type="submit" className="is-primary" disabled={!clean || busy}>{busy ? t('botMenu.saving') : t('botMenu.renameSubmit')}</button>
      </div>
    </BotSheet>
  )
}

/**
 * Delete, as Hermes does it (`groups.disband`): the room ends for all its members, its work is stopped, its id is
 * retired for good. The text says what stays and for how long.
 */
export function DeleteRoomDialog({ room, working, onDelete, onClose }: { room: Room; working: boolean; onDelete: () => Promise<void>; onClose: () => void }) {
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
      setError(failure instanceof Error ? failure.message : String(failure))
      setBusy(false)
    }
  }
  return (
    <BotSheet title={t('room.menu.deleteTitle', { name: room.name })} icon={<Trash2 size={18} />} danger busy={busy} onCancel={onClose} onSubmit={submit}>
      <p>{t('room.menu.deleteBody', { count: room.members.length })}</p>
      {working && <p>{t('room.menu.deleteWorking')}</p>}
      <p>{t('room.menu.deleteHistory')}</p>
      <p>{t('room.menu.deleteBots')}</p>
      {error && <p className="request-error" role="alert">{error}</p>}
      <div className="request-actions">
        <button type="button" onClick={onClose} disabled={busy} autoFocus>{t('botMenu.cancel')}</button>
        <button type="submit" className="is-danger" disabled={busy}>{busy ? t('room.menu.deleting') : t('room.menu.deleteSubmit')}</button>
      </div>
    </BotSheet>
  )
}
