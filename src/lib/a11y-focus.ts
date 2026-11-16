/** Where Tab should move inside a dialog. `null` lets the browser move between the ends. `-1` means focus is in the dialog but not on a control (the dialog itself). */
export function tabTrapIndex(count: number, activeIndex: number, shiftKey: boolean): number | null {
  if (count <= 0) return null
  if (shiftKey) return activeIndex <= 0 ? count - 1 : null
  if (activeIndex < 0 || activeIndex >= count - 1) return 0
  return null
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])'

/** Controls Tab can reach inside a dialog. The dialog's own `tabIndex={-1}` is not one of them. */
export function focusableElements(root: ParentNode) {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => !element.closest('[hidden], [aria-hidden="true"]'))
}

/**
 * Next tab in a horizontal tablist. `current` is -1 when focus is not on a tab
 * (a document's close button): arrows do nothing there.
 */
export function nextRovingIndex(count: number, current: number, key: string): number | null {
  if (count <= 0 || current < 0) return null
  if (key === 'ArrowRight') return (current + 1) % count
  if (key === 'ArrowLeft') return (current - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}

/** Context Menu key, or Shift+F10, opens a bot's menu. */
export function isContextMenuKey(key: string, shiftKey: boolean) {
  return key === 'ContextMenu' || (key === 'F10' && shiftKey)
}

export interface MenuRect {
  left: number
  right: number
  top: number
  bottom: number
}

/** Pointer opens at the click. The keyboard opens under the row, from its box. */
export function contextMenuPoint(row: MenuRect, clientX: number, clientY: number, keyboard: boolean) {
  const onRow = clientX >= row.left && clientX <= row.right && clientY >= row.top && clientY <= row.bottom
  return keyboard || !onRow ? { x: row.left + 28, y: row.bottom - 6 } : { x: clientX, y: clientY }
}
