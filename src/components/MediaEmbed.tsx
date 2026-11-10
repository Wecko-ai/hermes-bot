import { useTranslation } from 'react-i18next'
import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { ChevronLeft, ChevronRight, ExternalLink, FileText, ImageOff, X } from 'lucide-react'
import { isServablePath, mediaUrl, type MediaRef } from '../lib/media'

export interface ViewerState {
  images: MediaRef[]
  index: number
  profile: string
  version: string
}

interface MediaEmbedProps {
  media: MediaRef
  profile: string
  /** Message id: a new version of a file with the same name does not come from the cache. */
  version: string
  onOpenImage?: (media: MediaRef) => void
  onOpenDocument?: (media: MediaRef) => void
}

// Media that cannot be found: the viewer skips them. A media that eventually loads leaves the set.
const failedMedia = new Set<string>()
const failureKey = (profile: string, path: string) => `${profile}\n${path}`
export const mediaFailed = (profile: string, media: MediaRef) => failedMedia.has(failureKey(profile, media.path))

/** A bot `MEDIA:` item, read through the local server. Nothing loads directly from disk or from the outside. */
export function MediaEmbed({ media, profile, version, onOpenImage, onOpenDocument }: MediaEmbedProps) {
  const { t } = useTranslation()
  const [failed, setFailedState] = useState(false)
  const setFailed = (value: boolean) => {
    if (value) failedMedia.add(failureKey(profile, media.path))
    else failedMedia.delete(failureKey(profile, media.path))
    setFailedState(value)
  }
  if (media.kind === 'link') {
    // Project rule: a remote image never loads on its own, link only.
    return (
      <a className="media-card media-link" href={media.path} target="_blank" rel="noreferrer noopener" title={media.path}>
        <ExternalLink size={14} />
        <span className="media-card-text"><strong>{media.name}</strong><small>{t('media.externalLink')}</small></span>
      </a>
    )
  }
  if (media.kind === 'document' && isServablePath(media.path)) {
    return (
      <button type="button" className="media-card media-document" title={media.path} onClick={() => onOpenDocument?.(media)}>
        <FileText size={15} />
        <span className="media-card-text"><strong>{media.name}</strong><small>{t('media.openBeside')}</small></span>
      </button>
    )
  }
  if (failed || media.kind === 'file' || !isServablePath(media.path)) {
    const detail = failed ? t('media.previewUnavailable') : media.kind === 'file' ? t('media.localFile') : t('media.relativePath')
    return (
      <span className="media-card media-fallback" title={media.path}>
        {media.kind === 'file' || media.kind === 'document' ? <FileText size={15} /> : <ImageOff size={15} />}
        <span className="media-card-text"><strong>{media.name}</strong><small>{detail}</small></span>
      </span>
    )
  }
  const src = mediaUrl(profile, media.path, version)
  if (media.kind === 'image') {
    return (
      <button type="button" className="media-item media-thumb" title={media.name} aria-label={t('media.enlarge', { name: media.name })} onClick={() => onOpenImage?.(media)}>
        <img className="media-image" src={src} alt={media.name} loading="lazy" decoding="async" draggable={false} onLoad={() => setFailed(false)} onError={() => setFailed(true)} />
      </button>
    )
  }
  if (media.kind === 'video') {
    return (
      <span className="media-item media-video-frame">
        <video className="media-video" src={src} controls preload="metadata" playsInline title={media.name} onError={() => setFailed(true)} />
      </span>
    )
  }
  return (
    <span className="media-item media-audio-frame">
      <span className="media-audio-name">{media.name}</span>
      <audio className="media-audio" src={src} controls preload="metadata" onError={() => setFailed(true)} />
    </span>
  )
}

interface MediaViewerProps {
  viewer: ViewerState
  onClose: () => void
  onMove: (index: number) => void
}

const typingTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

/** Full-screen viewer: Esc closes, ← → move between slides, focus stays inside. */
export function MediaViewer({ viewer, onClose, onMove }: MediaViewerProps) {
  const { t } = useTranslation()
  const { images, index, profile, version } = viewer
  const count = images.length
  const media = images[index]
  const [failed, setFailed] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => setFailed(false), [index])
  // On close, focus goes back to where it was (the clicked thumbnail).
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => previous?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (typingTarget(event.target)) return
      if (event.key === 'Tab') {
        const focusable = [...(rootRef.current?.querySelectorAll<HTMLElement>('button') ?? [])]
        if (!focusable.length) return
        const position = focusable.indexOf(document.activeElement as HTMLElement)
        const next = (position + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length
        focusable[position < 0 ? 0 : next].focus()
      } else if (event.key === 'Escape') onClose()
      else if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && count > 1) onMove((index + (event.key === 'ArrowRight' ? 1 : -1) + count) % count)
      else return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [count, index, onClose, onMove])
  if (!media) return null
  const move = (step: number) => (event: MouseEvent) => {
    event.stopPropagation()
    onMove((index + step + count) % count)
  }
  return (
    <div className="media-viewer" ref={rootRef} role="dialog" aria-modal="true" aria-label={media.name} onClick={onClose}>
      <figure className="media-viewer-figure" onClick={(event) => event.stopPropagation()}>
        {failed
          ? <span className="media-viewer-missing"><ImageOff size={22} />{t('media.previewUnavailable')}</span>
          : <img key={media.path} src={mediaUrl(profile, media.path, version)} alt={media.name} onError={() => setFailed(true)} />}
        <figcaption>
          <span title={media.path}>{media.name}</span>
          {count > 1 && <span className="media-viewer-count">{index + 1} / {count}</span>}
        </figcaption>
      </figure>
      {count > 1 && (
        <>
          <button type="button" className="media-viewer-nav is-prev" aria-label={t('media.previous')} onClick={move(-1)}><ChevronLeft size={20} /></button>
          <button type="button" className="media-viewer-nav is-next" aria-label={t('media.next')} onClick={move(1)}><ChevronRight size={20} /></button>
        </>
      )}
      <button type="button" className="media-viewer-close" aria-label={t('media.close')} autoFocus onClick={(event) => { event.stopPropagation(); onClose() }}><X size={18} /></button>
    </div>
  )
}
