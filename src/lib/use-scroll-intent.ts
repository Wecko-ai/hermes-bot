import { useEffect, useRef } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'

// Keys that scroll a thread: they count as a user gesture.
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '])
// A scroll event this long after a gesture still belongs to it (trackpad inertia keeps sending wheel events).
export const USER_INTENT_MS = 1000

/**
 * Tells a scroll made by the user from one made by the layout. A thread that gets shorter, or a window that
 * opens taller, clamps scrollTop downward with no gesture: that must not detach the thread from its bottom.
 * Spread `handlers` on the scrolling element and call `noteIntent()` from its own `onWheel`.
 */
export function useScrollIntent() {
  const intentAtRef = useRef(0)
  const scrollbarHeldRef = useRef(false)
  useEffect(() => {
    const release = () => { scrollbarHeldRef.current = false }
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    return () => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
    }
  }, [])
  const noteIntent = () => { intentAtRef.current = Date.now() }
  /** The jump to the bottom ends the gesture before it: a later layout scroll must not detach the thread. */
  const clear = () => { intentAtRef.current = 0; scrollbarHeldRef.current = false }
  const userScrolling = () => scrollbarHeldRef.current || Date.now() - intentAtRef.current < USER_INTENT_MS
  const handlers = {
    onTouchStart: noteIntent,
    onTouchMove: noteIntent,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => { if (SCROLL_KEYS.has(event.key)) noteIntent() },
    // A press on the container itself is a press on its scrollbar: held until released.
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget) return
      scrollbarHeldRef.current = true
      noteIntent()
    },
  }
  return { noteIntent, userScrolling, clear, handlers }
}
