import { describe, expect, it } from 'vitest'
import { isImeComposition } from './keyboard'

describe('isImeComposition', () => {
  it('treats a composing Enter and key code 229 as IME confirmation', () => {
    expect(isImeComposition({ keyCode: 13, nativeEvent: { isComposing: true, keyCode: 13 } })).toBe(true)
    expect(isImeComposition({ keyCode: 229, nativeEvent: { isComposing: false, keyCode: 229 } })).toBe(true)
    expect(isImeComposition({ keyCode: 13, nativeEvent: { isComposing: false, keyCode: 229 } })).toBe(true)
  })

  it('lets a plain Enter through', () => {
    expect(isImeComposition({ keyCode: 13, nativeEvent: { isComposing: false, keyCode: 13 } })).toBe(false)
  })
})
