/** CDP Input.dispatchKeyEvent modifier bitmask (Alt=1, Ctrl=2, Meta/Command=4, Shift=8). */
export function cdpKeyModifiers(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
  let mask = 0
  if (event.altKey) mask |= 1
  if (event.ctrlKey) mask |= 2
  if (event.metaKey) mask |= 4
  if (event.shiftKey) mask |= 8
  return mask
}