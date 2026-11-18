import type { ReactNode } from 'react'
import { Check, ChevronRight } from 'lucide-react'
import './BotContextMenu.css'

/** Room kept between a menu and the window edge. */
export const EDGE = 8

export const ITEMS = '[role^="menuitem"]:not([aria-disabled="true"])'

/** Places a box at a point and keeps it inside the window, flipping it to the other side near an edge. */
export function place(box: DOMRect, x: number, y: number) {
  const left = x + box.width > window.innerWidth - EDGE ? x - box.width : x
  const top = y + box.height > window.innerHeight - EDGE ? y - box.height : y
  return {
    left: Math.max(EDGE, Math.min(left, window.innerWidth - EDGE - box.width)),
    top: Math.max(EDGE, Math.min(top, window.innerHeight - EDGE - box.height)),
  }
}

export function focusItem(menu: Element | null, which: 'first' | 'last' | 1 | -1) {
  if (!menu) return
  const items = [...menu.querySelectorAll<HTMLElement>(ITEMS)]
  if (!items.length) return
  const current = items.indexOf(document.activeElement as HTMLElement)
  const index = which === 'first' ? 0 : which === 'last' ? items.length - 1 : current < 0 ? (which === 1 ? 0 : items.length - 1) : (current + which + items.length) % items.length
  items[index].focus({ preventScroll: true })
}

export function MenuItem({ icon, label, disabled, danger, checked, submenu, expanded, onSelect, onHover }: {
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

