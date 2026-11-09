import { useState, type ReactNode } from 'react'
import { Menu, PanelRight, Search, X } from 'lucide-react'
import type { Bot, ChatMessage, SessionUsage } from '../types'
import { LiveAvatar, avatarPhase } from './LiveAvatar'
import { MessageList } from './MessageList'
import { Composer, type PendingImage } from './Composer'

interface ChatViewProps {
  bot: Bot
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
  onSend: (text: string, images: PendingImage[]) => void
  onStop: () => void
  modelLabel: string
  onOpenModels: (query: string) => void
  usage: SessionUsage | null
  showUsage: boolean
  onToggleUsage: () => void
  modelPicker?: ReactNode
}

export function ChatView(props: ChatViewProps) {
  const { bot } = props
  // Pendant un tour lancé ici, l’en-tête montre le travail même si le roster n’a pas encore suivi.
  const liveBot = props.running && avatarPhase(bot) !== 'working' ? { ...bot, status: 'working' as const } : bot
  const phase = avatarPhase(liveBot)
  const status = phase === 'working' ? 'Au travail' : phase === 'done' ? 'Terminé' : 'Disponible'
  const detail = phase === 'working' ? props.workText || props.activity : ''
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const visibleMessages = query.trim()
    ? props.messages.filter((message) => message.content.toLocaleLowerCase('fr').includes(query.trim().toLocaleLowerCase('fr')))
    : props.messages
  return (
    <main className="chat-panel">
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
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Rechercher dans cette conversation" aria-label="Texte à rechercher" autoFocus />
          <span>{query ? `${visibleMessages.length} résultat${visibleMessages.length > 1 ? 's' : ''}` : ''}</span>
          <button className="plain-icon" aria-label="Fermer la recherche" onClick={() => { setSearchOpen(false); setQuery('') }}><X size={15} /></button>
        </div>
      )}
      <MessageList
        bot={bot}
        messages={visibleMessages}
        streaming={props.streaming}
        streamKey={props.streamKey}
        running={props.running}
        activity={props.activity}
        loading={props.loading}
        onSuggestion={(text) => props.onSend(text, [])}
      />
      {props.modelPicker}
      <Composer
        bot={bot}
        running={props.running}
        disabled={props.loading}
        focusSignal={props.focusSignal}
        onSend={props.onSend}
        onStop={props.onStop}
        modelLabel={props.modelLabel}
        onOpenModels={props.onOpenModels}
        usage={props.usage}
        showUsage={props.showUsage}
        onToggleUsage={props.onToggleUsage}
      />
    </main>
  )
}
