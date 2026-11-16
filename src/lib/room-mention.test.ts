import { describe, expect, it } from 'vitest'
import { mentionKeyAction, type MentionKeyInput } from './room-mention'

const base = (overrides: Partial<MentionKeyInput> = {}): MentionKeyInput => ({
  key: 'Enter',
  keyCode: 13,
  composing: false,
  shiftKey: false,
  menuOpen: true,
  optionCount: 3,
  activeIndex: 1,
  ...overrides,
})

describe('room mention keys', () => {
  it('moves the active index with the arrows and wraps', () => {
    expect(mentionKeyAction(base({ key: 'ArrowDown' }))).toEqual({ type: 'move', index: 2 })
    expect(mentionKeyAction(base({ key: 'ArrowUp' }))).toEqual({ type: 'move', index: 0 })
    expect(mentionKeyAction(base({ key: 'ArrowDown', activeIndex: 2 }))).toEqual({ type: 'move', index: 0 })
    expect(mentionKeyAction(base({ key: 'ArrowUp', activeIndex: 0 }))).toEqual({ type: 'move', index: 2 })
  })

  it('inserts the active option on Enter and Tab, and closes on Escape', () => {
    expect(mentionKeyAction(base({ key: 'Enter', activeIndex: 2 }))).toEqual({ type: 'pick', index: 2 })
    expect(mentionKeyAction(base({ key: 'Tab', activeIndex: 0 }))).toEqual({ type: 'pick', index: 0 })
    expect(mentionKeyAction(base({ key: 'Escape' }))).toEqual({ type: 'close' })
  })

  it('does not pick or send while an IME composition is open', () => {
    expect(mentionKeyAction(base({ composing: true, key: 'Enter' }))).toEqual({ type: 'none' })
    expect(mentionKeyAction(base({ keyCode: 229, key: 'Enter', composing: false }))).toEqual({ type: 'none' })
    expect(mentionKeyAction(base({ composing: true, key: 'ArrowDown' }))).toEqual({ type: 'none' })
    expect(mentionKeyAction(base({ menuOpen: false, composing: true, key: 'Enter' }))).toEqual({ type: 'none' })
  })

  it('sends on Enter when the list is closed, and leaves Shift+Enter as a newline', () => {
    expect(mentionKeyAction(base({ menuOpen: false, key: 'Enter' }))).toEqual({ type: 'submit' })
    expect(mentionKeyAction(base({ menuOpen: false, key: 'Enter', shiftKey: true }))).toEqual({ type: 'none' })
    expect(mentionKeyAction(base({ menuOpen: false, key: 'ArrowDown' }))).toEqual({ type: 'none' })
    expect(mentionKeyAction(base({ menuOpen: false, key: 'Tab' }))).toEqual({ type: 'none' })
  })

  it('clamps a stale index onto the last option', () => {
    expect(mentionKeyAction(base({ key: 'Enter', optionCount: 2, activeIndex: 9 }))).toEqual({ type: 'pick', index: 1 })
  })
})
