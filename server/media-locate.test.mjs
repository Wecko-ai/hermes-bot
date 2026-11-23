import { describe, expect, it } from 'vitest'
import { isLocateName, locateCandidates, locateFromStatus, locateStep } from './media-locate.mjs'

describe('locate a cited file', () => {
  it('rejects a name that is already absolute or walks upward', () => {
    expect(isLocateName('1112.mov')).toBe(true)
    expect(isLocateName('capcut/1112.mov')).toBe(true)
    expect(isLocateName('/Volumes/Renders/video/capcut/1112.mov')).toBe(false)
    expect(isLocateName('../1112.mov')).toBe(false)
    expect(isLocateName('notes.txt')).toBe(false)
  })

  it('prefers the absolute path from the turn, then the workspace', () => {
    const hints = [
      '/Volumes/Renders/scratch/rush-1112-final/v1/livrables/other.mp4',
      '/Volumes/Renders/video/capcut/1112.mov',
    ]
    expect(locateCandidates('1112.mov', hints, '/tmp/work')).toEqual([
      '/Volumes/Renders/video/capcut/1112.mov',
      '/tmp/work/1112.mov',
    ])
  })

  it('does not guess when two files share the name', () => {
    expect(locateCandidates('1112.mov', ['/a/1112.mov', '/b/1112.mov'], '')).toEqual([
      '/a/1112.mov',
      '/b/1112.mov',
    ])
  })

  it('serves a local file, refuses one outside the roots, and asks the gateway when it is absent', () => {
    expect(locateStep({ ok: true })).toEqual({ action: 'use' })
    expect(locateStep({ ok: false, status: 403 })).toEqual({ action: 'stop', state: 'not_allowed' })
    expect(locateStep({ ok: false, status: 404 })).toEqual({ action: 'ask' })
    expect(locateStep(null, { remote: true })).toEqual({ action: 'ask' })
  })

  it('reads a gateway HEAD status', () => {
    expect(locateFromStatus(206)).toEqual({ action: 'use' })
    expect(locateFromStatus(403)).toEqual({ action: 'stop', state: 'not_allowed' })
    expect(locateFromStatus(404)).toEqual({ action: 'next' })
  })
})
