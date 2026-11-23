import { describe, expect, it } from 'vitest'
import { BACKGROUND_TASK_NOTE, TONE_CHARTER_NOTE, turnStyleNotes } from './turn-style'

describe('turnStyleNotes', () => {
  it('appends background and tone notes for this turn only', () => {
    const next = turnStyleNotes(undefined, 'Hello', { backgroundTask: true, toneCharter: true })
    expect(next).toBe(`Hello\n\n${BACKGROUND_TASK_NOTE}\n\n${TONE_CHARTER_NOTE}`)
    expect(BACKGROUND_TASK_NOTE).toContain('For this turn only')
    expect(TONE_CHARTER_NOTE).toContain('For this turn only')
  })

  it('leaves the text unchanged when both options are off', () => {
    expect(turnStyleNotes('Mode line', 'Hello', { backgroundTask: false, toneCharter: false })).toBe('Mode line')
  })
})