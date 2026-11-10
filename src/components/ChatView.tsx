import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { Menu, PanelRight, Search, Upload, X } from 'lucide-react'
import type { Bot, ChatMessage, SessionUsage } from '../types'
import type { MediaRef } from '../lib/media'
import { droppedFiles, type PendingAttachment } from '../lib/attachments'
import type { ChatMode } from '../lib/modes'
import { LiveAvatar, avatarPhase } from './LiveAvatar'
import { MessageList } from './MessageList'
import { Composer, type ComposerHandle } from './Composer'

interface ChatViewProps {
  /** Le chat local est à l’écran : cette vue reste montée, pour garder brouillon et position. */
  hidden?: boolean
  bot: Bot
  bots: Bot[]
  messages: ChatMessage[]
  streaming: string
  streamKey: string
  running: boolean
  activity: string
  workText: string
  loading: boolean
  detailsOpen: boolean
  focusSignal: number
  onOpenMobile: () => void
  onToggleDetails: () => void
  onSend: (text: string, attachments: PendingAttachment[], mode?: ChatMode) => Promise<boolean> | boolean | void
  onStop: () => void
  onNotice: (text: string) => void
  onOpenDocument: (profile: string, media: MediaRef) => void
  onOpenBot: (slug: string) => void
  modelLabel: string
  onOpenModels: (query: string) => void
  usage: SessionUsage | null
  showUsage: boolean
  onToggleUsage: () => void
  modelPicker?: ReactNode
}

const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files')

export function ChatView(props: ChatViewProps) {
  const { bot } = props
  // Pendant un tour lancé ici, l’en-tête montre le travail même si le roster n’a pas encore suivi.
  const liveBot = props.running && avatarPhase(bot) !== 'working' ? { ...bot, status: 'working' as const } : bot
  const phase = avatarPhase(liveBot)
  const status = phase === 'working' ? 'Au travail' : phase === 'done' ? 'Terminé' : 'Disponible'
  const detail = phase === 'working' ? props.workText || props.activity : ''
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const composerRef = useRef<ComposerHandle>(null)
  const [dragging, setDragging] = useState(false)
  // Passer d’un enfant à l’autre émet entrée et sortie : seul le compte dit si on a quitté la zone.
  const dragDepthRef = useRef(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const hiddenRef = useRef(false)
  hiddenRef.current = Boolean(props.hidden)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (hiddenRef.current || !event.metaKey || event.altKey || event.shiftKey || event.ctrlKey) return
      const key = event.key.toLowerCase()
      if (key === 'f') {
        event.preventDefault()
        setSearchOpen(true)
        requestAnimationFrame(() => searchRef.current?.focus())
      } else if (key === 'i') {
        event.preventDefault()
        composerRef.current?.focus()
      } else if (key === 'l') {
        const selection = window.getSelection()
        const inChat = selection?.anchorNode?.parentElement?.closest('.messages-scroll')
        if (!selection || selection.isCollapsed || !inChat) return
        event.preventDefault()
        composerRef.current?.quote(selection.toString())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const visibleMessages = query.trim()
    ? props.messages.filter((message) => message.content.toLocaleLowerCase('fr').includes(query.trim().toLocaleLowerCase('fr')))
    : props.messages
  return (
    <main
      className="chat-panel"
      hidden={props.hidden}
      onDragEnter={(event) => {
        if (!carriesFiles(event)) return
        event.preventDefault()
        dragDepthRef.current += 1
        setDragging(true)
      }}
      onDragOver={(event) => {
        if (!carriesFiles(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = props.loading ? 'none' : 'copy'
      }}
      onDragLeave={(event) => {
        if (!carriesFiles(event)) return
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
        if (dragDepthRef.current === 0) setDragging(false)
      }}
      onDrop={(event) => {
        if (!carriesFiles(event)) return
        event.preventDefault()
        dragDepthRef.current = 0
        setDragging(false)
        if (!props.loading) composerRef.current?.addFiles(droppedFiles(event.dataTransfer))
      }}
    >
      <header className="chat-header">
        <div className="chat-leading"><button className="plain-icon mobile-menu" aria-label="Afficher les bots" onClick={props.onOpenMobile}><Menu size={19} /></button></div>
        <div className={`chat-identity is-${phase}`} title={bot.role}>
          <LiveAvatar bot={liveBot} size={26} />
          <div>
            <h1>{bot.name}</h1>
            <p className="chat-status"><span className="chat-status-dot" aria-hidden="true" /><span aria-live="polite">{status}</span>{detail && <span className="chat-status-detail"> · {detail}</span>}</p>
          </div>
        </div>
        <div className="chat-header-actions">
          <button className={`plain-icon chat-search-button ${searchOpen ? 'is-active' : ''}`} aria-label="Rechercher dans la conversation" onClick={() => { setSearchOpen((value) => !value); setQuery('') }}><Search size={17} /></button>
          <button className={`plain-icon ${props.detailsOpen ? 'is-active' : ''}`} aria-label="Afficher les détails du bot" onClick={props.onToggleDetails}><PanelRight size={18} /></button>
        </div>
      </header>
      {searchOpen && (
        <div className="chat-search-bar">
          <Search size={15} />
          <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Rechercher dans cette conversation" aria-label="Texte à rechercher" autoFocus />
          <span>{query ? `${visibleMessages.length} résultat${visibleMessages.length > 1 ? 's' : ''}` : ''}</span>
          <button className="plain-icon" aria-label="Fermer la recherche" onClick={() => { setSearchOpen(false); setQuery('') }}><X size={15} /></button>
        </div>
      )}
      <MessageList
        bot={bot}
        bots={props.bots}
        messages={visibleMessages}
        streaming={props.streaming}
        streamKey={props.streamKey}
        running={props.running}
        activity={props.activity}
        loading={props.loading}
        onSuggestion={(text) => { void props.onSend(text, []) }}
        onOpenDocument={props.onOpenDocument}
        onOpenBot={props.onOpenBot}
      />
      {props.modelPicker}
      <Composer
        ref={composerRef}
        bot={bot}
        bots={props.bots}
        running={props.running}
        disabled={props.loading}
        focusSignal={props.focusSignal}
        onSend={props.onSend}
        onStop={props.onStop}
        onNotice={props.onNotice}
        modelLabel={props.modelLabel}
        onOpenModels={props.onOpenModels}
        usage={props.usage}
        showUsage={props.showUsage}
        onToggleUsage={props.onToggleUsage}
      />
      {dragging && <div className="drop-overlay" aria-hidden="true"><div><Upload size={22} /><strong>Dépose pour joindre à {bot.name}</strong><span>Images, vidéos, PDF, documents · 200 Mo maximum</span></div></div>}
    </main>
  )
}
