import { useTranslation } from 'react-i18next'
import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { ChevronLeft, ChevronRight, ExternalLink, FileText, Film, FolderOpen, ImageOff, Play, X } from 'lucide-react'
import { isServablePath, mediaLocateUrl, mediaUrl, videoPosterUrl, videoUrl, type MediaRef } from '../lib/media'

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
  /** Absolute paths from the same turn, used when the citation is only a name. */
  hints?: readonly string[]
  onOpenImage?: (media: MediaRef) => void
  onOpenDocument?: (media: MediaRef) => void
}

type PreviewReason = '' | 'unavailable' | 'notFound' | 'notAllowed'

async function responseStatus(url: string) {
  try {
    return (await fetch(url, { method: 'HEAD' })).status
  } catch {
    return 0
  }
}

// Media that cannot be found: the viewer skips them. A media that eventually loads leaves the set.
// Capped so a long session of broken paths cannot grow it for the life of the page.
export const FAILED_MEDIA_CAP = 500
const failedMedia = new Set<string>()
const failedOrder: string[] = []
const failureKey = (profile: string, path: string) => `${profile}\n${path}`

export function noteMediaFailure(profile: string, path: string) {
  const key = failureKey(profile, path)
  if (failedMedia.has(key)) return
  failedMedia.add(key)
  failedOrder.push(key)
  while (failedOrder.length > FAILED_MEDIA_CAP) {
    const oldest = failedOrder.shift()
    if (oldest) failedMedia.delete(oldest)
  }
}

export function clearMediaFailure(profile: string, path: string) {
  const key = failureKey(profile, path)
  if (!failedMedia.delete(key)) return
  const index = failedOrder.indexOf(key)
  if (index >= 0) failedOrder.splice(index, 1)
}

export const failedMediaCount = () => failedMedia.size
export const resetFailedMedia = () => { failedMedia.clear(); failedOrder.length = 0 }
export const mediaFailed = (profile: string, media: MediaRef) => failedMedia.has(failureKey(profile, media.path))

function MediaActions({ path }: { path: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const [finderFailed, setFinderFailed] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(path)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }
  return (
    <span className="media-card-actions">
      {window.hermesBot?.revealInFinder && (
        <button
          type="button"
          aria-label={t('media.open')}
          onClick={async () => {
            const shown = await window.hermesBot?.revealInFinder?.(path)
            setFinderFailed(!shown)
          }}
        >{t('media.open')}</button>
      )}
      <button type="button" aria-label={t('media.copyPath')} onClick={() => { void copy() }}>{copied ? t('media.copiedPath') : t('media.copyPath')}</button>
      {finderFailed && <span className="media-card-finder" role="alert">{t('media.finderUnavailable')}</span>}
    </span>
  )
}

function formatClock(seconds: number) {
  const total = Math.max(0, Math.round(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  const ss = String(rest).padStart(2, '0')
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`
  return `${minutes}:${ss}`
}

const posterBlobs = new Map<string, string>()
const POSTER_BLOB_CAP = 40

function rememberPoster(key: string, url: string) {
  posterBlobs.delete(key)
  posterBlobs.set(key, url)
  while (posterBlobs.size > POSTER_BLOB_CAP) {
    const oldest = posterBlobs.keys().next().value
    if (oldest === undefined) break
    const dropped = posterBlobs.get(oldest)
    posterBlobs.delete(oldest)
    if (dropped && dropped !== url) URL.revokeObjectURL(dropped)
  }
}

/** Poster first. A missing poster is a film card that still plays. A failed play returns to that card. */
function VideoCard({ profile, version, media, src, onFail }: { profile: string; version: string; media: MediaRef; src: string; onFail: () => void }) {
  const { t } = useTranslation()
  const [playing, setPlaying] = useState(false)
  const [poster, setPoster] = useState('')
  const [duration, setDuration] = useState('')
  const [stillFailed, setStillFailed] = useState(false)
  const posterRequest = videoPosterUrl(profile, media.path, version)
  useEffect(() => {
    const controller = new AbortController()
    setPlaying(false)
    setDuration('')
    setStillFailed(false)
    const cached = posterBlobs.get(posterRequest)
    if (cached) {
      setPoster(cached)
      return () => controller.abort()
    }
    setPoster('')
    void fetch(posterRequest, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return
        const seconds = Number(response.headers.get('X-Video-Duration'))
        if (Number.isFinite(seconds) && seconds > 0) setDuration(formatClock(seconds))
        const blob = await response.blob()
        const url = URL.createObjectURL(blob)
        rememberPoster(posterRequest, url)
        if (!controller.signal.aborted) setPoster(url)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [posterRequest])
  if (playing) {
    return (
      <span className="media-item media-video-frame">
        <video
          className="media-video"
          src={`${src}#t=1`}
          poster={poster || undefined}
          controls
          autoPlay
          playsInline
          title={media.name}
          onError={(event) => { if (event.currentTarget.error) onFail() }}
        />
      </span>
    )
  }
  return (
    <button type="button" className="media-video-card" title={media.path} aria-label={t('media.play', { name: media.name })} onClick={() => setPlaying(true)}>
      {poster
        ? <img className="media-video-poster" src={poster} alt="" />
        : stillFailed
          ? <span className="media-video-fallback"><Film size={18} /><span className="media-card-text"><strong>{media.name}</strong><small>{t('media.preview.video')}</small></span></span>
          : <video className="media-video-still" src={`${src}#t=1`} preload="metadata" muted playsInline tabIndex={-1} onError={(event) => { if (event.currentTarget.error) setStillFailed(true) }} />}
      {poster && <span className="media-video-play" aria-hidden><Play size={16} /></span>}
      {duration && <span className="media-video-duration">{duration}</span>}
    </button>
  )
}

/** A bot `MEDIA:` item, read through the local server. Nothing loads directly from disk or from the outside. */
export function MediaEmbed({ media, profile, version, hints = [], onOpenImage, onOpenDocument }: MediaEmbedProps) {
  const { t } = useTranslation()
  const [path, setPath] = useState(media.path)
  const [failed, setFailedState] = useState(false)
  const [reason, setReason] = useState<PreviewReason>('')
  const [locating, setLocating] = useState(false)
  const hintKey = hints.join('\n')
  const setFailed = (value: boolean) => {
    if (value) noteMediaFailure(profile, path)
    else clearMediaFailure(profile, path)
    setFailedState(value)
  }
  useEffect(() => {
    setPath(media.path)
    setFailedState(false)
    setReason('')
    clearMediaFailure(profile, media.path)
  }, [media.path, profile])
  useEffect(() => {
    if (isServablePath(media.path) || (media.kind !== 'image' && media.kind !== 'video' && media.kind !== 'audio')) return undefined
    let cancel = false
    setLocating(true)
    void fetch(mediaLocateUrl(profile, media.path, hintKey ? hintKey.split('\n') : []))
      .then((response) => response.ok ? response.json() as Promise<{ path?: string; state?: string }> : null)
      .then((body) => {
        if (cancel || !body) return
        if (body.state === 'ok' && typeof body.path === 'string' && isServablePath(body.path)) {
          setPath(body.path)
          setReason('')
        } else setReason(body.state === 'not_allowed' ? 'notAllowed' : 'notFound')
      })
      .catch(() => { if (!cancel) setReason('notFound') })
      .finally(() => { if (!cancel) setLocating(false) })
    return () => { cancel = true }
  }, [hintKey, media.kind, media.path, profile])
  const classify = async (url: string) => {
    const status = await responseStatus(url)
    setReason(status === 403 ? 'notAllowed' : status === 404 ? 'notFound' : 'unavailable')
    setFailed(true)
  }
  const shown: MediaRef = path === media.path ? media : { ...media, path, name: path.split(/[\\/]/).filter(Boolean).at(-1) || media.name }
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
  const unresolved = !isServablePath(path)
  if (locating && unresolved) {
    return (
      <span className="media-card media-fallback" title={media.path}>
        <ImageOff size={15} />
        <span className="media-card-text"><strong>{media.name}</strong><small>{t('media.locating')}</small></span>
      </span>
    )
  }
  if (failed || media.kind === 'file' || unresolved) {
    const detail = reason === 'notAllowed' ? t('media.notAllowed')
      : reason === 'notFound' || unresolved ? t('media.notFound')
        : failed ? t('media.previewUnavailable')
          : t('media.localFile')
    return (
      <span className="media-card media-fallback" title={path}>
        {media.kind === 'file' || media.kind === 'document' ? <FileText size={15} /> : <ImageOff size={15} />}
        <span className="media-card-text">
          <strong>{shown.name}</strong>
          <small>{detail}</small>
          <MediaActions path={path} />
        </span>
      </span>
    )
  }
  const src = shown.kind === 'video' ? videoUrl(profile, path, version) : mediaUrl(profile, path, version)
  if (shown.kind === 'image') {
    return (
      <button type="button" className="media-item media-thumb" title={shown.name} aria-label={t('media.enlarge', { name: shown.name })} onClick={() => onOpenImage?.(shown)}>
        <img className="media-image" src={src} alt={shown.name} loading="lazy" decoding="async" draggable={false} onLoad={() => setFailed(false)} onError={() => { void classify(src) }} />
      </button>
    )
  }
  if (shown.kind === 'video') {
    return <VideoCard profile={profile} version={version} media={shown} src={src} onFail={() => { void classify(src) }} />
  }
  return (
    <span className="media-item media-audio-frame">
      <span className="media-audio-name">{shown.name}</span>
      <audio className="media-audio" src={src} controls preload="metadata" onError={() => { void classify(src) }} />
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
  const [finderFailed, setFinderFailed] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => { setFailed(false); setFinderFailed(false) }, [index])
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
          {window.hermesBot?.revealInFinder
            ? <button
                type="button"
                className="media-viewer-path"
                title={media.path}
                aria-label={t('media.openFinder', { name: media.name })}
                onClick={async (event) => {
                  event.stopPropagation()
                  const shown = await window.hermesBot?.revealInFinder?.(media.path)
                  setFinderFailed(!shown)
                }}
              ><FolderOpen size={13} /><span>{media.name}</span></button>
            : <span title={media.path}>{media.name}</span>}
          {count > 1 && <span className="media-viewer-count">{index + 1} / {count}</span>}
          {finderFailed && <span className="media-viewer-finder-error" role="alert">{t('media.finderUnavailable')}</span>}
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
