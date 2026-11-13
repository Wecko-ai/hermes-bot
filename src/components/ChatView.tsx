import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Menu, PanelRight, Search, Upload, X } from 'lucide-react'
import type { Bot, ChatMessage, SessionUsage } from '../types'
import type { MediaRef } from '../lib/media'
import { droppedFiles, type PendingAttachment } from '../lib/attachments'
import type { ChatMode } from '../lib/modes'
import type { DeliveryMode } from '../lib/delivery'
import { LiveAvatar, avatarPhase } from './LiveAvatar'
import { MessageList } from './MessageList'
import { Composer, type ComposerHandle } from './Composer'
import { PromptCard } from './PromptCard'
import type { PendingPrompt } from '../lib/hermes'
import { SubagentsPanel } from './SubagentsPanel'
import type { SubagentEntry } from '../lib/subagent-history'
import { backgroundSummary, type SubagentTail } from '../lib/background'

interface ChatViewProps {
  /** The local chat is on screen: this view stays mounted, to keep its draft and position. */
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
  onSend: (text: string, attachments: PendingAttachment[], mode?: ChatMode, delivery?: DeliveryMode) => Promise<boolean> | boolean | void
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
  /** Open questions and approvals of this chat: the bot stays blocked while they wait. */
  prompts: PendingPrompt[]
  onAnswerPrompt: (prompt: PendingPrompt, answer: string) => Promise<void>
  /** Children delegated in this conversation, and its background processes still running. */
  subagents: SubagentEntry[]
  processes: number
  onLoadSubagentTail: (subagentId: string) => Promise<SubagentTail>
  /** Opens the Subagents tab of the details panel. */
  onOpenSubagentHistory: () => void
}

const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files')

export function ChatView(props: ChatViewProps) {
  const { t } = useTranslation()
  const { bot } = props
  // An open question blocks the turn: the bot is waiting for the user, not working.
  const waiting = props.prompts.length > 0
  // During a turn started here, the header shows the work even if the roster hasn’t caught up yet.
  const liveBot = waiting ? { ...bot, status: 'waiting' as const } : props.running && avatarPhase(bot) !== 'working' ? { ...bot, status: 'working' as const } : bot
  const phase = avatarPhase(liveBot)
  const status = t(`status.${waiting ? 'waiting' : phase}`)
  // Standing by: what still runs, on hover.
  const standby = !waiting && phase === 'standby' ? backgroundSummary(liveBot.background) : ''
  const detail = phase === 'working' ? props.workText || props.activity : ''
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  // Matches counted by the message list, the current one (-1 before the first Enter) and a counter that makes each Enter scroll.
  const [matchCount, setMatchCount] = useState(0)
  const [position, setPosition] = useState(-1)
  const [jump, setJump] = useState(0)
  const composerRef = useRef<ComposerHandle>(null)
  const [dragging, setDragging] = useState(false)
  // Moving from one child to another fires enter and leave: only the count tells whether we left the zone.
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
  const closeSearch = () => { setSearchOpen(false); setQuery(''); setPosition(-1) }
  // Enter goes to the most recent match, then to older ones and wraps; Shift+Enter goes the other way.
  const step = (older: boolean) => {
    if (!matchCount) return
    setPosition((current) => (current < 0 ? (older ? matchCount - 1 : 0) : (current + (older ? -1 : 1) + matchCount) % matchCount))
    setJump((value) => value + 1)
  }
  const counter = !query.trim() ? '' : matchCount === 0 ? t('chat.noResults') : position >= 0 ? t('chat.position', { current: position + 1, total: matchCount }) : t('chat.results', { count: matchCount })
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
        <div className="chat-leading"><button className="plain-icon mobile-menu" aria-label={t('chat.showBots')} onClick={props.onOpenMobile}><Menu size={19} /></button></div>
        <div className={`chat-identity is-${waiting ? 'waiting' : phase}`} title={standby || bot.role}>
          <LiveAvatar bot={liveBot} size={26} />
          <div>
            <h1>{bot.name}</h1>
            <p className="chat-status"><span className="chat-status-dot" aria-hidden="true" /><span aria-live="polite">{status}</span>{standby && <span className="visually-hidden"> · {standby}</span>}{detail && <span className="chat-status-detail"> · {detail}</span>}</p>
          </div>
        </div>
        <div className="chat-header-actions">
          <button className={`plain-icon chat-search-button ${searchOpen ? 'is-active' : ''}`} aria-label={t('chat.searchConversation')} onClick={() => { if (searchOpen) closeSearch(); else setSearchOpen(true) }}><Search size={17} /></button>
          <button className={`plain-icon ${props.detailsOpen ? 'is-active' : ''}`} aria-label={t('chat.showDetails')} onClick={props.onToggleDetails}><PanelRight size={18} /></button>
        </div>
      </header>
      {searchOpen && (
        <div className="chat-search-bar">
          <Search size={15} />
          <input ref={searchRef} value={query} onChange={(event) => { setQuery(event.target.value); setPosition(-1) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); step(!event.shiftKey) }
              else if (event.key === 'Escape') { event.preventDefault(); closeSearch() }
            }}
            placeholder={t('chat.searchPlaceholder')} aria-label={t('chat.searchLabel')} autoFocus />
          <span className="chat-search-count" role="status" aria-live="polite">{counter}</span>
          <button className="plain-icon" aria-label={t('chat.closeSearch')} onClick={closeSearch}><X size={15} /></button>
        </div>
      )}
      <MessageList
        bot={waiting ? liveBot : bot}
        bots={props.bots}
        messages={props.messages}
        search={{ query, position, jump }}
        onSearchCount={(count) => { setMatchCount(count); setPosition((current) => (current >= count ? -1 : current)) }}
        streaming={props.streaming}
        streamKey={props.streamKey}
        running={props.running}
        activity={props.activity}
        workText={props.workText}
        loading={props.loading}
        onSuggestion={(text) => { void props.onSend(text, []) }}
        onOpenDocument={props.onOpenDocument}
        onOpenBot={props.onOpenBot}
      />
      {props.modelPicker}
      {!props.hidden && <SubagentsPanel key={bot.slug} entries={props.subagents} processes={props.processes} onLoadTail={props.onLoadSubagentTail} onOpenHistory={props.onOpenSubagentHistory} onOpenDocument={(media) => props.onOpenDocument(bot.slug, media)} />}
      {props.prompts[0] && !props.hidden && (
        <div className="prompt-dock">
          <PromptCard key={props.prompts[0].promptId} prompt={props.prompts[0]} botName={bot.name} onAnswer={props.onAnswerPrompt} />
        </div>
      )}
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
      {dragging && <div className="drop-overlay" aria-hidden="true"><div><Upload size={22} /><strong>{t('chat.dropTo', { name: bot.name })}</strong><span>{t('chat.dropHint')}</span></div></div>}
    </main>
  )
}
