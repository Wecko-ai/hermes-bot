import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Bell, Check, ChevronRight, Copy, Eye, EyeOff, Folder, FolderPlus, Pin, PinOff, SquarePen, Trash2 } from 'lucide-react'
import type { Bot } from '../types'
import type { BotAction } from '../lib/bot-actions'
import { newSectionId, type BotSection } from '../lib/bot-manage'
import { UNASSIGNED_SECTION_ID } from '../lib/roster-groups'
import './BotContextMenu.css'

/** Room kept between a menu and the window edge. */
const EDGE = 8

interface BotContextMenuProps {
  bot: Bot
  /** Viewport point the menu opens at: the pointer, or the row when opened from the keyboard. */
  at: { x: number; y: number }
  pinned: boolean
  /** Sections the bot can be moved to, in sidebar order. */
  sections: BotSection[]
  /** Hermes answers (or the demo runs): the actions that write to it are offered. */
  canManage: boolean
  onAction: (action: BotAction) => void
  onRename: () => void
  onDelete: () => void
  /** `restoreFocus`: closed from the keyboard or by an action, focus goes back to the bot's row. */
  onClose: (restoreFocus: boolean) => void
}

const ITEMS = '[role^="menuitem"]:not([aria-disabled="true"])'

/** Places a box at a point and keeps it inside the window, flipping it to the other side near an edge. */
function place(box: DOMRect, x: number, y: number) {
  const left = x + box.width > window.innerWidth - EDGE ? x - box.width : x
  const top = y + box.height > window.innerHeight - EDGE ? y - box.height : y
  return {
    left: Math.max(EDGE, Math.min(left, window.innerWidth - EDGE - box.width)),
    top: Math.max(EDGE, Math.min(top, window.innerHeight - EDGE - box.height)),
  }
}

function focusItem(menu: Element | null, which: 'first' | 'last' | 1 | -1) {
  if (!menu) return
  const items = [...menu.querySelectorAll<HTMLElement>(ITEMS)]
  if (!items.length) return
  const current = items.indexOf(document.activeElement as HTMLElement)
  const index = which === 'first' ? 0 : which === 'last' ? items.length - 1 : current < 0 ? (which === 1 ? 0 : items.length - 1) : (current + which + items.length) % items.length
  items[index].focus({ preventScroll: true })
}

function MenuItem({ icon, label, disabled, danger, checked, submenu, expanded, onSelect, onHover }: {
  icon: ReactNode
  label: string
  disabled?: boolean
  danger?: boolean
  checked?: boolean
  submenu?: boolean
  expanded?: boolean
  onSelect: () => void
  onHover?: () => void
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      aria-haspopup={submenu ? 'menu' : undefined}
      aria-expanded={submenu ? Boolean(expanded) : undefined}
      tabIndex={-1}
      className={`bot-menu-item${danger ? ' is-danger' : ''}${expanded ? ' is-open' : ''}`}
      onClick={() => { if (!disabled) onSelect() }}
      // The item under the pointer is the active one, so the keyboard carries on from there.
      onPointerMove={(event) => { if (!disabled && document.activeElement !== event.currentTarget) event.currentTarget.focus({ preventScroll: true }) }}
      onPointerEnter={onHover}
    >
      <span className="bot-menu-icon" aria-hidden="true">{icon}</span>
      <span className="bot-menu-label">{label}</span>
      {submenu && <ChevronRight className="bot-menu-chevron" size={15} aria-hidden="true" />}
      {checked && <Check className="bot-menu-check" size={15} aria-hidden="true" />}
    </button>
  )
}

/**
 * Right-click menu of a bot in the sidebar. Pin and mark as read stay on this Mac; move, rename, hide and
 * delete write the bot's card in Hermes, through the sidebar's `onAction` and dialogs.
 */
export function BotContextMenu({ bot, at, pinned, sections, canManage, onAction, onRename, onDelete, onClose }: BotContextMenuProps) {
  const { t } = useTranslation()
  const menuRef = useRef<HTMLDivElement>(null)
  const subRef = useRef<HTMLDivElement>(null)
  const moveRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const [subOpen, setSubOpen] = useState(false)
  const [subPosition, setSubPosition] = useState<{ left: number; top: number } | null>(null)
  const [naming, setNaming] = useState(false)
  const [sectionName, setSectionName] = useState('')
  const [copy, setCopy] = useState<'idle' | 'done' | 'failed'>('idle')
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // The sidebar re-renders with every roster read: the listeners below must not follow its callback.
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const sessionId = bot.sessionId || ''

  useLayoutEffect(() => {
    if (!menuRef.current) return
    setPosition(place(menuRef.current.getBoundingClientRect(), at.x, at.y))
  }, [at.x, at.y])

  useEffect(() => {
    if (position) focusItem(menuRef.current, 'first')
  }, [position !== null])

  // The submenu opens beside its item, on the side with room.
  useLayoutEffect(() => {
    if (!subOpen || !subRef.current || !moveRef.current || !menuRef.current) { setSubPosition(null); return }
    const item = moveRef.current.querySelector('[aria-haspopup]')!.getBoundingClientRect()
    const menu = menuRef.current.getBoundingClientRect()
    const box = subRef.current.getBoundingClientRect()
    const right = menu.right - 2
    const left = right + box.width > window.innerWidth - EDGE ? menu.left - box.width + 2 : right
    const top = Math.max(EDGE, Math.min(item.top - 5, window.innerHeight - EDGE - box.height))
    setSubPosition({ left: Math.max(EDGE, left), top })
  }, [subOpen, naming, sections.length, position])

  // Click or scroll elsewhere, another window, a resized window: the menu goes away.
  useEffect(() => {
    const outside = (event: Event) => {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !subRef.current?.contains(target)) closeRef.current(false)
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

  const act = (action: BotAction) => {
    onClose(true)
    onAction(action)
  }

  const openSub = (focus: boolean) => {
    setSubOpen(true)
    if (focus) setTimeout(() => focusItem(subRef.current, 'first'), 0)
  }

  const closeSub = () => {
    setSubOpen(false)
    setNaming(false)
    setSectionName('')
    moveRef.current?.querySelector<HTMLElement>('[aria-haspopup]')?.focus({ preventScroll: true })
  }

  const copyId = () => {
    if (!sessionId) return
    navigator.clipboard.writeText(sessionId).then(() => setCopy('done'), () => setCopy('failed')).finally(() => {
      closeTimer.current = setTimeout(() => closeRef.current(true), 900)
    })
  }

  const createSection = () => {
    const name = sectionName.trim()
    if (!name) return
    act({ type: 'move', section: { id: newSectionId(), name } })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const inSub = Boolean(subRef.current?.contains(event.target as Node))
    const typing = (event.target as HTMLElement).tagName === 'INPUT'
    const menu = inSub ? subRef.current : menuRef.current
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (typing) { setNaming(false); setTimeout(() => focusItem(subRef.current, 'last'), 0) }
      // A submenu opened by hovering closes first, as in a macOS menu.
      else if (inSub || subOpen) closeSub()
      else onClose(true)
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      onClose(true)
      return
    }
    if (typing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      focusItem(menu, event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      focusItem(menu, event.key === 'Home' ? 'first' : 'last')
    } else if (event.key === 'ArrowRight' && !inSub && (event.target as HTMLElement).getAttribute('aria-haspopup')) {
      event.preventDefault()
      openSub(true)
    } else if (event.key === 'ArrowLeft' && inSub) {
      event.preventDefault()
      closeSub()
    }
  }

  const currentSection = bot.sectionId === UNASSIGNED_SECTION_ID ? null : bot.sectionId
  const copyLabel = copy === 'done' ? t('botMenu.copied') : copy === 'failed' ? t('botMenu.copyFailed') : t('botMenu.copyId')
  const hideSub = () => { if (subOpen) { setSubOpen(false); setNaming(false) } }

  return createPortal(
    <div className="bot-menu-layer" onKeyDown={onKeyDown} onContextMenu={(event) => event.preventDefault()}>
      <div
        ref={menuRef}
        className={`bot-menu${position ? ' is-placed' : ''}`}
        role="menu"
        aria-label={t('botMenu.label', { name: bot.name })}
        style={position ?? { left: at.x, top: at.y }}
      >
        <MenuItem icon={pinned ? <PinOff size={16} /> : <Pin size={16} />} label={pinned ? t('botMenu.unpin') : t('botMenu.pin')} onSelect={() => act({ type: pinned ? 'unpin' : 'pin' })} onHover={hideSub} />
        <div ref={moveRef} className="bot-menu-anchor">
          <MenuItem icon={<Folder size={16} />} label={t('botMenu.moveTo')} submenu expanded={subOpen} disabled={!canManage} onSelect={() => (subOpen ? closeSub() : openSub(true))} onHover={() => openSub(false)} />
        </div>
        <MenuItem icon={<Bell size={16} />} label={t('botMenu.markRead')} disabled={bot.unread === 0} onSelect={() => act({ type: 'markRead' })} onHover={hideSub} />
        <div className="bot-menu-separator" role="separator" />
        <MenuItem icon={<SquarePen size={16} />} label={t('botMenu.rename')} disabled={!canManage} onSelect={() => { onClose(false); onRename() }} onHover={hideSub} />
        <div className="bot-menu-separator" role="separator" />
        <MenuItem icon={copy === 'done' ? <Check size={16} /> : <Copy size={16} />} label={copyLabel} disabled={!sessionId} onSelect={copyId} onHover={hideSub} />
        <div className="bot-menu-separator" role="separator" />
        <MenuItem
          icon={bot.hidden ? <Eye size={16} /> : <EyeOff size={16} />}
          label={bot.hidden ? t('botMenu.show') : t('botMenu.hide')}
          disabled={!canManage}
          onSelect={() => act({ type: bot.hidden ? 'show' : 'hide' })}
          onHover={hideSub}
        />
        <MenuItem icon={<Trash2 size={16} />} label={t('botMenu.delete')} danger disabled={!canManage} onSelect={() => { onClose(false); onDelete() }} onHover={hideSub} />
      </div>
      <span className="visually-hidden" role="status">{copy === 'done' ? t('botMenu.copied') : ''}</span>
      {subOpen && (
        <div
          ref={subRef}
          className={`bot-menu is-sub${subPosition ? ' is-placed' : ''}`}
          role="menu"
          aria-label={t('botMenu.sections')}
          style={subPosition ?? { left: -9999, top: 0 }}
        >
          {sections.map((section) => (
            <MenuItem
              key={section.id}
              icon={<Folder size={16} />}
              label={section.name}
              checked={section.id === currentSection}
              onSelect={() => (section.id === currentSection ? onClose(true) : act({ type: 'move', section }))}
            />
          ))}
          <MenuItem
            icon={<Folder size={16} />}
            label={t('sidebar.sectionUnassigned')}
            checked={currentSection === null}
            onSelect={() => (currentSection === null ? onClose(true) : act({ type: 'move', section: null }))}
          />
          <div className="bot-menu-separator" role="separator" />
          {naming ? (
            <form className="bot-menu-new" onSubmit={(event) => { event.preventDefault(); createSection() }}>
              <FolderPlus size={16} aria-hidden="true" />
              <input
                autoFocus
                value={sectionName}
                maxLength={60}
                placeholder={t('botMenu.newSectionName')}
                aria-label={t('botMenu.newSectionName')}
                onChange={(event) => setSectionName(event.target.value)}
              />
              <button type="submit" disabled={!sectionName.trim()}>{t('botMenu.createSection')}</button>
            </form>
          ) : (
            <MenuItem icon={<FolderPlus size={16} />} label={t('botMenu.newSection')} onSelect={() => setNaming(true)} />
          )}
        </div>
      )}
    </div>,
    document.body,
  )
}
