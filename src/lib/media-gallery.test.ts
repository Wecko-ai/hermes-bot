import { describe, expect, it } from 'vitest'
import { filterGalleryItems, galleryCounts } from './media-gallery'

const item = (kind: 'image' | 'video' | 'audio', path: string) => ({ ref: { path, name: path, kind }, version: '1' })

describe('media-gallery', () => {
  it('filters by media kind', () => {
    const items = [item('image', '/a.png'), item('video', '/b.mp4'), item('audio', '/c.mp3')]
    expect(filterGalleryItems(items, 'video')).toHaveLength(1)
    expect(galleryCounts(items)).toEqual({ all: 3, image: 1, video: 1, audio: 1 })
  })
})