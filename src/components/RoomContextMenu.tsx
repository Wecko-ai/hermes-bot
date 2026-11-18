import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Check, Copy, DoorOpen, Square, SquarePen, Trash2 } from 'lucide-react'
import type { Room } from '../lib/rooms'
import { focusItem, MenuItem, place } from './ContextMenuParts'
import './BotContextMenu.css'

export type RoomMenuAction = 'open' | 'stop'

interface RoomContextMenuProps {
  room: Room
  /** Viewport point the menu opens at: the pointer, or the row when opened from the keyboard. */
  at: { x: number; y: number }
  working: boolean
  canRename: boolean
  canDisband: boolean
  /** Hermes answers (or the demo runs): the actions that write to it are offered. */
  canManage: boolean
  onAction: (action: RoomMenuAction) => void
  onRename: () => void
  onDelete: () => void
  /** `restoreFocus`: closed from the keyboard or by an action, focus goes back to the room's row. */
  onClose: (restoreFocus: boolean) => void
}

/** Right-click menu of a room in the sidebar. Same glass and keyboard behavior as the bot menu. */
export function RoomContextMenu({ room, at, working, canRename, canDisband, canManage, onAction, onRename, onDelete, onClose }: RoomContextMenuProps) {
  const { t } = useTranslation()
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const [copy, setCopy] = useState<'idle' | 'done' | 'failed'>('idle')
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // The sidebar re-renders with every room read: the listeners below must not follow its callback.
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useLayoutEffect(() => {
    if (menuRef.current) setPosition(place(menuRef.current.getBoundingClientRect(), at.x, at.y))
  }, [at.x, at.y])

  useEffect(() => {
    if (position) focusItem(menuRef.current, 'first')
  }, [position !== null])

  // Click or scroll elsewhere, another window, a resized window: the menu goes away.
  useEffect(() => {
    const outside = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) closeRef.current(false)
    }
    const away = () => closeRef.current(false)
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('wheel', outside, { capture: true, passive: true })
    window.addEventListener('blur', away)
    window.addEventListener('resize', away)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('wheel', outside, { capture: true })
      window.removeEventListener('blur', away)
      window.removeEventListener('resize', away)
      clearTimeout(closeTimer.current)
    }
  }, [])

  const act = (action: RoomMenuAction) => {
    onClose(true)
    onAction(action)
  }

  const copyId = () => {
    navigator.clipboard.writeText(room.room_id).then(() => setCopy('done'), () => setCopy('failed')).finally(() => {
      closeTimer.current = setTimeout(() => closeRef.current(true), 900)
    })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose(true)
    } else if (event.key === 'Tab') {
      event.preventDefault()
      onClose(true)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      focusItem(menuRef.current, event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      focusItem(menuRef.current, event.key === 'Home' ? 'first' : 'last')
    }
  }

  const copyLabel = copy === 'done' ? t('room.menu.copied') : copy === 'failed' ? t('room.menu.copyFailed') : t('room.menu.copyId')

  return createPortal(
    <div className="bot-menu-layer" onKeyDown={onKeyDown} onContextMenu={(event) => event.preventDefault()}>
      <div
        ref={menuRef}
        className={`bot-menu${position ? ' is-placed' : ''}`}
        role="menu"
        aria-label={t('room.menu.label', { name: room.name })}
        style={position ?? { left: at.x, top: at.y }}
      >
        <MenuItem icon={<DoorOpen size={16} />} label={t('room.menu.open')} onSelect={() => act('open')} />
        <MenuItem icon={<SquarePen size={16} />} label={t('room.menu.rename')} disabled={!canManage || !canRename} onSelect={() => { onClose(false); onRename() }} />
        {working && <MenuItem icon={<Square size={16} />} label={t('room.menu.stop')} disabled={!canManage} onSelect={() => act('stop')} />}
        <div className="bot-menu-separator" role="separator" />
        <MenuItem icon={copy === 'done' ? <Check size={16} /> : <Copy size={16} />} label={copyLabel} onSelect={copyId} />
        <div className="bot-menu-separator" role="separator" />
        <MenuItem icon={<Trash2 size={16} />} label={t('room.menu.delete')} danger disabled={!canManage || !canDisband} onSelect={() => { onClose(false); onDelete() }} />
      </div>
      <span className="visually-hidden" role="status">{copy === 'done' ? t('room.menu.copied') : ''}</span>
    </div>,
    document.body,
  )
}
