import { beforeEach, describe, expect, it } from 'vitest'
import type { MediaRef } from '../lib/media'
import { FAILED_MEDIA_CAP, clearMediaFailure, failedMediaCount, mediaFailed, noteMediaFailure, resetFailedMedia } from './MediaEmbed'

const media = (path: string): MediaRef => ({ path, name: path, kind: 'image' })

describe('failedMedia', () => {
  beforeEach(() => resetFailedMedia())

  it('drops the oldest entry once 500 paths have failed', () => {
    for (let index = 0; index < FAILED_MEDIA_CAP + 100; index += 1) noteMediaFailure('bot', String(index))
    expect(failedMediaCount()).toBe(FAILED_MEDIA_CAP)
    expect(mediaFailed('bot', media('0'))).toBe(false)
    expect(mediaFailed('bot', media('99'))).toBe(false)
    expect(mediaFailed('bot', media('100'))).toBe(true)
    expect(mediaFailed('bot', media(String(FAILED_MEDIA_CAP + 99)))).toBe(true)
  })

  it('does not reorder or grow when the same path fails again', () => {
    for (let index = 0; index < FAILED_MEDIA_CAP + 100; index += 1) noteMediaFailure('bot', String(index))
    noteMediaFailure('bot', '100')
    noteMediaFailure('bot', String(FAILED_MEDIA_CAP + 100))
    expect(failedMediaCount()).toBe(FAILED_MEDIA_CAP)
    expect(mediaFailed('bot', media('100'))).toBe(false)
    expect(mediaFailed('bot', media('101'))).toBe(true)
    expect(mediaFailed('bot', media(String(FAILED_MEDIA_CAP + 100)))).toBe(true)
  })

  it('forgets a path that later loads', () => {
    noteMediaFailure('bot', 'a.png')
    noteMediaFailure('bot', 'b.png')
    clearMediaFailure('bot', 'a.png')
    expect(mediaFailed('bot', media('a.png'))).toBe(false)
    expect(mediaFailed('bot', media('b.png'))).toBe(true)
    expect(failedMediaCount()).toBe(1)
  })
})
