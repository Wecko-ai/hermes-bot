import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const { localMediaPath, revealMedia } = createRequire(import.meta.url)('./reveal-media.cjs')

describe('revealMedia', () => {
  it('reveals an existing absolute file', () => {
    const reveal = vi.fn()
    expect(revealMedia('/tmp/image.png', { exists: () => true, reveal })).toBe(true)
    expect(reveal).toHaveBeenCalledWith('/tmp/image.png')
  })

  it('resolves a home-relative path on this Mac', () => {
    const reveal = vi.fn()
    expect(revealMedia('~/Pictures/image.png', { home: '/Users/test', exists: () => true, reveal })).toBe(true)
    expect(reveal).toHaveBeenCalledWith('/Users/test/Pictures/image.png')
  })

  it('refuses a relative or missing path without opening anything', () => {
    const reveal = vi.fn()
    expect(localMediaPath('image.png')).toBeNull()
    expect(revealMedia('image.png', { exists: () => true, reveal })).toBe(false)
    expect(revealMedia('/missing/image.png', { exists: () => false, reveal })).toBe(false)
    expect(reveal).not.toHaveBeenCalled()
  })
})
