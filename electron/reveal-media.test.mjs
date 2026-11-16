import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const { localMediaPath, revealMedia, REVEAL_EXTENSIONS } = createRequire(import.meta.url)('./reveal-media.cjs')

const file = { isFile: () => true }
const directory = { isFile: () => false }

function statOf(entries) {
  return (filePath) => {
    if (!Object.prototype.hasOwnProperty.call(entries, filePath)) {
      const error = new Error('missing')
      error.code = 'ENOENT'
      throw error
    }
    return entries[filePath]
  }
}

describe('revealMedia', () => {
  it('reveals an existing regular file of an allowed type', () => {
    const reveal = vi.fn()
    const stat = statOf({ '/tmp/image.png': file })
    expect(revealMedia('/tmp/image.png', { stat, reveal })).toBe(true)
    expect(reveal).toHaveBeenCalledWith('/tmp/image.png')
  })

  it('accepts every media and document extension the server serves, in any case', () => {
    const reveal = vi.fn()
    for (const extension of REVEAL_EXTENSIONS) {
      const local = `/tmp/clip.${extension}`
      expect(revealMedia(local, { stat: statOf({ [local]: file }), reveal }), extension).toBe(true)
    }
    expect(revealMedia('/tmp/photo.PNG', { stat: statOf({ '/tmp/photo.PNG': file }), reveal })).toBe(true)
    expect(reveal).toHaveBeenCalledTimes(REVEAL_EXTENSIONS.size + 1)
  })

  it('resolves a home-relative path on this Mac', () => {
    const reveal = vi.fn()
    const local = '/Users/test/Pictures/image.png'
    expect(revealMedia('~/Pictures/image.png', { home: '/Users/test', stat: statOf({ [local]: file }), reveal })).toBe(true)
    expect(reveal).toHaveBeenCalledWith(local)
  })

  it('refuses a directory, a missing file, and anything outside the allowlist', () => {
    const reveal = vi.fn()
    const stat = statOf({
      '/tmp/folder.png': directory,
      '/tmp/notes': directory,
      '/tmp/run.sh': file,
      '/tmp/pic.svg': file,
      '/tmp/noext': file,
    })
    expect(localMediaPath('image.png')).toBeNull()
    expect(revealMedia('image.png', { stat, reveal })).toBe(false)
    expect(revealMedia('/missing/image.png', { stat, reveal })).toBe(false)
    expect(revealMedia('/tmp/folder.png', { stat, reveal })).toBe(false)
    expect(revealMedia('/tmp/notes', { stat, reveal })).toBe(false)
    expect(revealMedia('/tmp/run.sh', { stat, reveal })).toBe(false)
    expect(revealMedia('/tmp/pic.svg', { stat, reveal })).toBe(false)
    expect(revealMedia('/tmp/noext', { stat, reveal })).toBe(false)
    expect(reveal).not.toHaveBeenCalled()
  })
})
