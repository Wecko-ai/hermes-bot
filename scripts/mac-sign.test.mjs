import { describe, expect, it } from 'vitest'
import macSign from './mac-sign.cjs'

const { signModeFrom, isBundleExecutable } = macSign

describe('macSign setting', () => {
  it('stays off unless a mode is given', () => {
    for (const value of [undefined, null, false, '', ' ', 'false', 'off', 'none', 'no', '0', 'OFF']) expect(signModeFrom(value), String(value)).toBeNull()
  })

  it('keeps the mode or the identity as written', () => {
    expect(signModeFrom('adhoc')).toBe('adhoc')
    expect(signModeFrom(' adhoc-bundle ')).toBe('adhoc-bundle')
    expect(signModeFrom('HermesBot Local Signing')).toBe('HermesBot Local Signing')
  })

  it('refuses a value that is not a string', () => {
    expect(() => signModeFrom(true)).toThrow()
    expect(() => signModeFrom({ identity: 'x' })).toThrow()
  })
})

describe('nested code', () => {
  it('leaves a bundle’s own executable to the bundle', () => {
    expect(isBundleExecutable('/A.app/Contents/MacOS/A')).toBe(true)
    expect(isBundleExecutable('/A.app/Contents/Frameworks/B.framework/Versions/A/B')).toBe(true)
    expect(isBundleExecutable('/A.app/Contents/Frameworks/B.framework/Versions/A/Helpers/crashpad')).toBe(false)
    expect(isBundleExecutable('/A.app/Contents/Frameworks/B.framework/Versions/A/Libraries/libx.dylib')).toBe(false)
  })
})
