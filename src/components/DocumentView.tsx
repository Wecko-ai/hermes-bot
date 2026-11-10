import { useCallback, useEffect, useState } from 'react'
import { Download, FileWarning, RotateCw } from 'lucide-react'
import { documentFormat, documentUrl, type MediaRef } from '../lib/media'
import { Markdown } from './MessageList'
import { MediaViewer, type ViewerState } from './MediaEmbed'

export interface OpenDocument {
  id: string
  profile: string
  path: string
  name: string
  /** Augmente à chaque rechargement, ou quand le bot renvoie le même fichier. */
  revision: number
}

interface DocumentViewProps {
  document: OpenDocument
  active: boolean
  onReload: () => void
}

type LoadState = 'loading' | 'ready' | 'missing' | 'tooLarge'

/** Un document du bot dans son onglet : PDF natif, page HTML isolée, ou Markdown rendu comme le chat. */
export function DocumentView({ document, active, onReload }: DocumentViewProps) {
  const format = documentFormat(document.path)
  const url = documentUrl(document.profile, document.path, document.revision)
  const [state, setState] = useState<LoadState>('loading')
  const [text, setText] = useState('')
  const [viewer, setViewer] = useState<ViewerState | null>(null)
  const openImages = useCallback((images: MediaRef[], index: number, version: string) => {
    if (images.length) setViewer({ images, index, profile: document.profile, version })
  }, [document.profile])
  const closeViewer = useCallback(() => setViewer(null), [])
  const moveViewer = useCallback((index: number) => setViewer((current) => current && { ...current, index }), [])

  // Une iframe afficherait le JSON d’erreur du serveur : on vérifie d’abord que le fichier se lit.
  useEffect(() => {
    const controller = new AbortController()
    setState('loading')
    fetch(url, { method: format === 'markdown' ? 'GET' : 'HEAD', credentials: 'same-origin', signal: controller.signal }).then(async (response) => {
      if (response.status === 413) return setState('tooLarge')
      if (!response.ok) return setState('missing')
      if (format === 'markdown') setText(await response.text())
      setState('ready')
    }).catch((error) => {
      if (error.name !== 'AbortError') setState('missing')
    })
    return () => controller.abort()
  }, [url, format])

  return (
    <section className="document-view" hidden={!active} aria-label={document.name}>
      <div className="document-toolbar">
        <span title={document.path}>{document.path}</span>
        <button className="plain-icon" aria-label={`Recharger ${document.name}`} onClick={onReload}><RotateCw size={14} /></button>
        <a className="plain-icon" aria-label={`Télécharger ${document.name}`} href={url} download={document.name}><Download size={14} /></a>
      </div>
      {state === 'loading' && <div className="document-state">Ouverture…</div>}
      {(state === 'missing' || state === 'tooLarge') && (
        <div className="document-state is-error"><FileWarning size={20} />{state === 'tooLarge' ? 'Fichier trop lourd pour l’aperçu (16 Mo maximum).' : 'Aperçu indisponible.'}</div>
      )}
      {state === 'ready' && format === 'pdf' && <iframe key={url} className="document-frame" title={document.name} src={url} />}
      {/* Sans allow-same-origin : la page n’atteint ni l’app, ni sa session. */}
      {state === 'ready' && format === 'html' && <iframe key={url} className="document-frame" title={document.name} src={url} sandbox="allow-scripts" referrerPolicy="no-referrer" />}
      {state === 'ready' && format === 'markdown' && (
        <div className="document-markdown message-content"><Markdown content={text} profile={document.profile} version={`${document.path}#${document.revision}`} onOpenImages={openImages} /></div>
      )}
      {viewer && <MediaViewer viewer={viewer} onClose={closeViewer} onMove={moveViewer} />}
    </section>
  )
}
