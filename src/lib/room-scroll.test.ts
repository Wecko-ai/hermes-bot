import { describe, expect, it } from 'vitest'
import { nextStick, roomSendSettled, roomStopStillCurrent } from './room-scroll'

describe('room transcript stick', () => {
  it('stays unstuck 40px above the bottom after a wheel-up', () => {
    expect(nextStick(true, -120, 40)).toBe(false)
    // The scroll event that follows must not pin the thread again just because it is near the bottom.
    expect(nextStick(false, 0, 40)).toBe(false)
  })

  it('unsticks when the reader moves away, including a drag or a key that leaves the edge', () => {
    expect(nextStick(true, -1, 0)).toBe(false)
    expect(nextStick(true, -40, 200)).toBe(false)
    expect(nextStick(false, 20, 81)).toBe(false)
  })

  it('resticks only when the reader moves down onto the bottom edge', () => {
    expect(nextStick(false, 30, 40)).toBe(true)
    expect(nextStick(false, 30, 80)).toBe(true)
    expect(nextStick(true, 4, 0)).toBe(true)
  })

  it('keeps the current pin when the thread grows without a user scroll', () => {
    expect(nextStick(true, 0, 400)).toBe(true)
    expect(nextStick(false, 0, 0)).toBe(false)
  })
})

describe('room send completion', () => {
  it('clears the field only when the send succeeded and that room is still shown', () => {
    expect(roomSendSettled('room-a', 'room-a', true)).toEqual({ clearStorage: true, clearField: true })
    expect(roomSendSettled('room-a', 'room-b', true)).toEqual({ clearStorage: true, clearField: false })
    expect(roomSendSettled('room-a', 'room-a', false)).toEqual({ clearStorage: false, clearField: false })
  })

  it('clears the stop flag only for the room that was stopped', () => {
    expect(roomStopStillCurrent('room-a', 'room-a')).toBe(true)
    expect(roomStopStillCurrent('room-a', 'room-b')).toBe(false)
  })
})
