import { describe, expect, it } from 'vitest'
import { STICK_EDGE_PX, nextStick } from './scroll-stick'

describe('nextStick', () => {
  it('stays unstuck 40px above the bottom after a wheel-up', () => {
    expect(STICK_EDGE_PX).toBeGreaterThan(40)
    const afterWheel = nextStick(true, -1, 40)
    expect(afterWheel).toBe(false)
    // The scroll event that follows has no further movement. Proximity must not pin again.
    expect(nextStick(afterWheel, 0, 40)).toBe(false)
  })

  it('re-pins only when the user moves down onto the bottom edge', () => {
    expect(nextStick(false, 4, 0)).toBe(true)
    expect(nextStick(false, 4, 40)).toBe(true)
    expect(nextStick(false, 4, 200)).toBe(false)
  })

  it('does not detach a pinned thread when the layout grows without a user move', () => {
    expect(nextStick(true, 0, 400)).toBe(true)
    expect(nextStick(true, 0, 0)).toBe(true)
  })

  it('detaches when the user scrolls up past the edge', () => {
    expect(nextStick(true, -20, 200)).toBe(false)
  })

  it('keeps a pinned follow that is still moving toward the edge', () => {
    expect(nextStick(true, 30, 200)).toBe(true)
  })
})
