import type { MediaRef } from './media'

export type MediaGalleryFilter = 'all' | 'image' | 'video' | 'audio'

export interface GalleryItem {
  ref: MediaRef
  version: string
}

export function filterGalleryItems(items: GalleryItem[], filter: MediaGalleryFilter): GalleryItem[] {
  if (filter === 'all') return items
  return items.filter((item) => item.ref.kind === filter)
}

export function galleryCounts(items: GalleryItem[]) {
  const counts: Record<MediaGalleryFilter, number> = { all: items.length, image: 0, video: 0, audio: 0 }
  for (const item of items) {
    if (item.ref.kind === 'image' || item.ref.kind === 'video' || item.ref.kind === 'audio') counts[item.ref.kind] += 1
  }
  return counts
}