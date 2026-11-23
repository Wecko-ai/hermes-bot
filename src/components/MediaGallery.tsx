import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { filterGalleryItems, galleryCounts, type GalleryItem, type MediaGalleryFilter } from '../lib/media-gallery'
import { MediaEmbed, MediaViewer, type ViewerState } from './MediaEmbed'
import type { MediaRef } from '../lib/media'

const FILTERS: MediaGalleryFilter[] = ['all', 'image', 'video', 'audio']

interface MediaGalleryProps {
  items: GalleryItem[]
  profile: string
  onOpenDocument: (media: MediaRef) => void
}

export function MediaGallery({ items, profile, onOpenDocument }: MediaGalleryProps) {
  const { t } = useTranslation()
  const [filter, setFilter] = useState<MediaGalleryFilter>('all')
  const [viewer, setViewer] = useState<ViewerState | null>(null)
  const counts = useMemo(() => galleryCounts(items), [items])
  const visible = useMemo(() => filterGalleryItems(items, filter), [items, filter])
  const images = visible.filter((item) => item.ref.kind === 'image').map((item) => item.ref)

  const openImage = (media: MediaRef, version?: string) => {
    const index = images.findIndex((item) => item.path === media.path)
    if (index >= 0) setViewer({ images, index, profile, version: version ?? '' })
  }

  return (
    <>
      <div className="media-gallery-filters" role="tablist" aria-label={t('mediaGallery.all')}>
        {FILTERS.map((id) => (
          <button key={id} type="button" role="tab" aria-selected={filter === id} className={filter === id ? 'is-active' : ''} onClick={() => setFilter(id)}>
            {t(`mediaGallery.${id === 'all' ? 'all' : id === 'image' ? 'images' : id === 'video' ? 'videos' : 'audio'}`)} ({counts[id]})
          </button>
        ))}
      </div>
      <div className="media-gallery-grid">
        {visible.map(({ ref, version }) => (
          <MediaEmbed key={ref.path} media={ref} profile={profile} version={version} onOpenImage={(item) => openImage(item, version)} onOpenDocument={onOpenDocument} />
        ))}
      </div>
      {viewer && <MediaViewer viewer={viewer} onClose={() => setViewer(null)} onMove={(index) => setViewer((current) => current && { ...current, index })} />}
    </>
  )
}