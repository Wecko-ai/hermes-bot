import { describe, expect, it } from 'vitest'
import { cdpKeyModifiers } from './cdp-modifiers'

describe('cdpKeyModifiers', () => {
  it('maps platform keys to the CDP bitmask', () => {
    expect(cdpKeyModifiers({ altKey: false, ctrlKey: true, metaKey: true, shiftKey: false })).toBe(6)
    expect(cdpKeyModifiers({ altKey: true, ctrlKey: false, metaKey: false, shiftKey: true })).toBe(9)
  })
})