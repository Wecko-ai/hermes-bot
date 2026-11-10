import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import { Check, Copy, ArrowDown, ChevronDown } from 'lucide-react'
import ReactMarkdown, { type Components, type ExtraProps, type Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AgentMessage, Bot, ChatMessage } from '../types'
import { BotAvatar, statusLabel } from './BotAvatar'
import { LiveAvatar } from './LiveAvatar'
import { MediaEmbed, MediaViewer, mediaFailed, type ViewerState } from './MediaEmbed'
import { MailBlock, MailContext } from './MailCard'
import { isServablePath, mediaIndex, referencedFiles, remarkMedia, withoutUnfinishedTag, type MediaRef, type MediaSink } from '../lib/media'
import { mentionedSlug, mentionIndex as buildMentionIndex, remarkMentions } from '../lib/mentions'
import { approvedMailIds, MAIL_APPROVED_FENCE, MAIL_FENCE } from '../lib/mail'
import { mayBecomeSilent } from '../lib/hermes'
import { messageDay, shortTime } from '../lib/time'

type OpenImages = (images: MediaRef[], index: number, version: string) => void

interface MediaContextValue {
  sink: MediaSink
  profile: string
  version: string
  streaming: boolean
  openImage: (media: MediaRef) => void
  openDocument?: (media: MediaRef) => void
}

interface MentionContextValue {
  index: Map<string, string | null>
  bots: Map<string, Bot>
  onOpenBot: (slug: string) => void
}

// Les composants Markdown restent au niveau du module : une nouvelle identité à chaque rendu
// remonterait tout le sous-arbre, et une vidéo en lecture repartirait à zéro pendant le streaming.
const MediaContext = createContext<MediaContextValue | null>(null)
const MentionContext = createContext<MentionContextValue | null>(null)

function MarkdownLink({ href, children, node: _node, ...props }: ComponentProps<'a'> & ExtraProps) {
  const context = useContext(MediaContext)
  const mentions = useContext(MentionContext)
  const media = context?.sink.media[mediaIndex(href)]
  if (context && media) return <MediaEmbed media={media} profile={context.profile} version={context.version} onOpenImage={context.openImage} onOpenDocument={context.openDocument} />
  const mentioned = mentionedSlug(href)
  if (mentioned) return <button type="button" className="mention-chip" onClick={() => mentions?.onOpenBot(mentioned)}>{children}</button>
  return <a {...props} href={href} target="_blank" rel="noreferrer noopener">{children}</a>
}

/**
 * Un paragraphe fait seulement de médias devient une galerie (plusieurs images à la suite). Toujours un
 * `<p>` : changer d’élément quand du texte arrive après un média remonterait une vidéo en lecture.
 */
function MarkdownParagraph({ node, children }: ComponentProps<'p'> & ExtraProps) {
  const nodes = node?.children || []
  const media = nodes.filter((child) => child.type === 'element' && child.tagName === 'a' && mediaIndex(String(child.properties?.href ?? '')) >= 0)
  const onlyMedia = media.length > 0 && nodes.every((child) => media.includes(child)
    || (child.type === 'text' && !child.value.trim())
    || (child.type === 'element' && child.tagName === 'br'))
  return <p className={onlyMedia ? `media-group ${media.length === 1 ? 'is-single' : 'is-grid'}` : undefined}>{children}</p>
}

// Une image distante chargée toute seule peut faire fuiter des données dans son URL.
function MarkdownImage({ src, alt }: ComponentProps<'img'> & ExtraProps) {
  const url = typeof src === 'string' ? src : ''
  if (url.startsWith('data:image/') || url.startsWith('blob:')) return <img src={url} alt={alt || ''} />
  return <a href={url} target="_blank" rel="noreferrer noopener">{alt || 'Image'}</a>
}

/** Un bloc de code `hermes-mail` devient la carte de mail à valider. */
function MarkdownPre({ node, children, ...props }: ComponentProps<'pre'> & ExtraProps) {
  const context = useContext(MediaContext)
  const code = node?.children[0]
  const language = code?.type === 'element' && code.tagName === 'code' && Array.isArray(code.properties?.className) ? String(code.properties.className[0]) : ''
  if (code?.type === 'element' && (language === `language-${MAIL_FENCE}` || language === `language-${MAIL_APPROVED_FENCE}`)) {
    const source = code.children.map((child) => (child.type === 'text' ? child.value : '')).join('')
    return <MailBlock source={source} approvedBlock={language === `language-${MAIL_APPROVED_FENCE}`} streaming={Boolean(context?.streaming)} />
  }
  return <pre {...props}>{children}</pre>
}

const MARKDOWN_COMPONENTS: Components = { a: MarkdownLink, p: MarkdownParagraph, img: MarkdownImage, pre: MarkdownPre }

interface MarkdownProps {
  content: string
  profile: string
  /** Identifiant du message : versionne les URL des médias. */
  version: string
  streaming?: boolean
  /** Montre sous le texte les images, vidéos, sons et PDF que le bot cite par leur chemin. */
  citedFiles?: boolean
  onOpenImages: OpenImages
  onOpenDocument?: (media: MediaRef) => void
}

interface CitedFilesProps {
  files: MediaRef[]
  profile: string
  version: string
  onOpenImages: OpenImages
  onOpenDocument?: (media: MediaRef) => void
}

/** Ce que le bot a produit, lisible sans quitter le chat : vignettes, lecteurs, PDF à côté. */
function CitedFiles({ files, profile, version, onOpenImages, onOpenDocument }: CitedFilesProps) {
  const openImage = (item: MediaRef) => {
    const images = files.filter((entry) => entry === item || (entry.kind === 'image' && !mediaFailed(profile, entry)))
    onOpenImages(images, Math.max(0, images.indexOf(item)), version)
  }
  return (
    <div className="cited-files">
      <div className="cited-files-label">{files.length === 1 ? 'Fichier cité' : `${files.length} fichiers cités`}</div>
      <div className="cited-files-grid">
        {files.map((file) => <MediaEmbed key={file.path} media={file} profile={profile} version={version} onOpenImage={openImage} onOpenDocument={onOpenDocument} />)}
      </div>
    </div>
  )
}

export const Markdown = memo(function Markdown({ content, profile, version, streaming = false, citedFiles = false, onOpenImages, onOpenDocument }: MarkdownProps) {
  const source = useMemo(() => (streaming ? withoutUnfinishedTag(content) : content), [content, streaming])
  // Un collecteur par texte : le plugin y range les médias, les liens #media:<index> y renvoient.
  const sink = useMemo<MediaSink>(() => ({ media: [] }), [source])
  const mentionIndexValue = useContext(MentionContext)?.index
  const plugins = useMemo<NonNullable<Options['remarkPlugins']>>(() => [
    remarkGfm,
    [remarkMedia, sink],
    ...(mentionIndexValue ? [[remarkMentions, { index: mentionIndexValue }] as [typeof remarkMentions, { index: Map<string, string | null> }]] : []),
  ], [sink, mentionIndexValue])
  const context = useMemo<MediaContextValue>(() => ({
    sink,
    profile,
    version,
    streaming,
    openImage: (item) => {
      // Toutes les images lisibles du message, dans l’ordre : on passe d’une slide à l’autre.
      const images = sink.media.filter((entry) => entry === item || (entry.kind === 'image' && isServablePath(entry.path) && !mediaFailed(profile, entry)))
      onOpenImages(images, Math.max(0, images.indexOf(item)), version)
    },
    openDocument: onOpenDocument,
  }), [sink, profile, version, streaming, onOpenImages, onOpenDocument])
  // Pendant le streaming, un chemin peut être coupé : les fichiers s’affichent à la fin du message.
  const files = useMemo(() => (citedFiles && !streaming ? referencedFiles(source) : []), [citedFiles, streaming, source])
  return (
    <MediaContext.Provider value={context}>
      <ReactMarkdown remarkPlugins={plugins} components={MARKDOWN_COMPONENTS}>{source}</ReactMarkdown>
      {files.length > 0 && <CitedFiles files={files} profile={profile} version={version} onOpenImages={onOpenImages} onOpenDocument={onOpenDocument} />}
    </MediaContext.Provider>
  )
})

interface MessageProps {
  message: ChatMessage
  profile: string
  onOpenImages: OpenImages
  onOpenDocument: (media: MediaRef) => void
}

// Un message que l’utilisateur vient d’envoyer entre en douceur ; le fil chargé ou mis en cache s’affiche tel quel.
const isEntering = (message: ChatMessage) => message.id.startsWith('local-') && Date.now() - Date.parse(message.createdAt || '') < 2500

/** Bot nommé par Hermes (`iris`, `@iris`, `Dr. Foo`, `moxie@homelab`) : le bot du roster, ou le nom tel quel. */
function AgentName({ handle, fallback }: { handle: string; fallback?: string }) {
  const mentions = useContext(MentionContext)
  const tag = handle.trim().replace(/^@/, '').toLowerCase()
  const slug = mentions?.index.get(tag) ?? mentions?.index.get(tag.split('@')[0]) ?? mentionedSlugOf(fallback || '', mentions?.index)
  const bot = slug ? mentions?.bots.get(slug) : undefined
  if (!bot) return <span className="agent-note-name">{fallback || handle.replace(/^@/, '')}</span>
  return (
    <button type="button" className="agent-note-name" onClick={() => mentions?.onOpenBot(bot.slug)} title={`Ouvrir ${bot.name}`}>
      <BotAvatar bot={bot} size={16} />{bot.name}
    </button>
  )
}

function mentionedSlugOf(name: string, index?: Map<string, string | null>) {
  const form = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return form ? index?.get(form) ?? undefined : undefined
}

const AGENT_VERBS: Record<AgentMessage['kind'], string> = { message: 'messaged', reply: 'replied to', 'no-reply': 'hasn’t replied to' }

/** « Orion messaged Iris » : le verbe ouvre le message, chaque nom ouvre son bot. */
function AgentNote({ message, profile, onOpenImages, onOpenDocument }: MessageProps) {
  const [open, setOpen] = useState(false)
  const agent = message.agent as AgentMessage
  return (
    <div className={`agent-note is-${agent.kind} ${open ? 'is-open' : ''}`}>
      <div className="agent-note-line">
        <AgentName handle={agent.from} fallback={agent.fromName} />{' '}
        <button type="button" className="agent-note-verb" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {AGENT_VERBS[agent.kind]}<ChevronDown size={11} aria-hidden="true" />
        </button>{' '}
        <AgentName handle={agent.to} />
        {message.createdAt && <>{' '}<time>{shortTime(message.createdAt)}</time></>}
      </div>
      {open && (
        <div className="agent-note-body message-content">
          {agent.text
            ? <Markdown content={agent.text} profile={profile} version={message.id} citedFiles onOpenImages={onOpenImages} onOpenDocument={onOpenDocument} />
            : <p className="agent-note-empty">Message vide.</p>}
        </div>
      )}
    </div>
  )
}

const Message = memo(function Message({ message, profile, onOpenImages, onOpenDocument }: MessageProps) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(message.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }
  if (message.agent) return <AgentNote message={message} profile={profile} onOpenImages={onOpenImages} onOpenDocument={onOpenDocument} />
  if (message.role === 'system' || message.role === 'tool') {
    return <div className="system-message">{message.content}</div>
  }
  return (
    <article className={`message message-${message.role} ${message.streaming ? 'is-streaming' : ''} ${message.failed ? 'is-failed' : ''} ${isEntering(message) ? 'is-entering' : ''}`}>
      <div className="message-content">
        <Markdown content={message.content} profile={profile} version={message.id} streaming={message.streaming} citedFiles={message.role === 'assistant'} onOpenImages={onOpenImages} onOpenDocument={onOpenDocument} />
        {message.streaming && <span className="stream-caret" />}
      </div>
      {!message.streaming && (
        <div className="message-meta">
          <span>{message.pending ? 'Envoi…' : message.failed ? 'Échec de l’envoi' : shortTime(message.createdAt)}</span>
          {message.role === 'assistant' && <button className="message-copy" aria-label="Copier la réponse" onClick={copy}>{copied ? <Check size={13} /> : <Copy size={13} />}</button>}
        </div>
      )}
    </article>
  )
})

// Touches qui font défiler le fil : elles comptent comme un geste de l’utilisateur.
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '])

interface MessageListProps {
  bot: Bot
  bots: Bot[]
  messages: ChatMessage[]
  streaming: string
  /** Identifiant du tour en cours : le message final le reprend, la bulle n’est pas remontée. */
  streamKey: string
  running: boolean
  activity: string
  loading: boolean
  onSuggestion: (text: string) => void
  onOpenDocument: (profile: string, media: MediaRef) => void
  onOpenBot: (slug: string) => void
}

export function MessageList({ bot, bots, messages, streaming, streamKey, running, activity, loading, onSuggestion, onOpenDocument, onOpenBot }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const columnRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const intentAtRef = useRef(0)
  const [showJump, setShowJump] = useState(false)
  const [viewer, setViewer] = useState<ViewerState | null>(null)
  const visibleMessages = messages.filter((message) => message.agent || (!message.technical && message.role !== 'system' && message.role !== 'tool'))
  // Un `NOREPLY` en cours d’écriture ne s’affiche jamais : on montre le bot au travail à la place.
  const silentStream = Boolean(streaming) && mayBecomeSilent(streaming)
  const items = streaming && !silentStream
    ? [...visibleMessages, { id: streamKey || 'live-stream', role: 'assistant', content: streaming, createdAt: null, streaming: true } satisfies ChatMessage]
    : visibleMessages
  const count = items.length
  const profile = bot.slug
  const mailContext = useMemo(() => ({ profile, running, approved: approvedMailIds(messages), onApprove: onSuggestion }), [profile, running, messages, onSuggestion])
  // Le roster est relu toutes les 30 s : tant que les noms ne changent pas, aucun message n’est réanalysé.
  const rosterKey = bots.map((item) => `${item.slug}\n${item.name}\n${item.avatar?.shape}\n${item.avatar?.color}`).join('\n')
  const mentionValue = useMemo<MentionContextValue>(() => ({
    index: buildMentionIndex(bots),
    // Avatar fixe dans le fil : un bot nommé ne s’anime jamais ici, même au travail.
    bots: new Map(bots.map((item) => [item.slug, { ...item, status: 'idle' as const }])),
    onOpenBot,
  }), [rosterKey, onOpenBot])

  const openDocument = useCallback((media: MediaRef) => onOpenDocument(profile, media), [onOpenDocument, profile])
  const openImages = useCallback<OpenImages>((images, index, version) => {
    if (images.length) setViewer({ images, index, profile, version })
  }, [profile])
  const closeViewer = useCallback(() => setViewer(null), [])
  const moveViewer = useCallback((index: number) => setViewer((current) => current && { ...current, index }), [])

  const followBottom = () => endRef.current?.scrollIntoView({ block: 'end', behavior: 'instant' })
  const scrollToBottom = (smooth = false) => {
    stickToBottomRef.current = true
    setShowJump(false)
    endRef.current?.scrollIntoView({ block: 'end', behavior: smooth ? 'smooth' : 'instant' })
  }
  // On suit l’intention de l’utilisateur, pas la géométrie : un défilement programmé ou une image qui charge
  // ne décroche jamais le fil ; une molette vers le haut le décroche tout de suite, avant même le scroll.
  const noteIntent = () => { intentAtRef.current = Date.now() }
  const unstick = () => {
    stickToBottomRef.current = false
    setShowJump(true)
  }
  useEffect(() => {
    setViewer(null)
    scrollToBottom()
  }, [bot.slug])
  useEffect(() => {
    if (stickToBottomRef.current) followBottom()
  }, [count, streaming, running, loading])
  // Une image ou une vidéo qui finit de charger agrandit le fil : on reste en bas seulement si l’utilisateur y était.
  useEffect(() => {
    const column = columnRef.current
    if (!column || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (stickToBottomRef.current) followBottom()
    })
    observer.observe(column)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="messages-viewport">
      <div
        className="messages-scroll"
        ref={scrollRef}
        onWheel={(event) => {
          noteIntent()
          if (event.deltaY < 0) unstick()
        }}
        onTouchStart={noteIntent}
        onTouchMove={noteIntent}
        onKeyDown={(event) => { if (SCROLL_KEYS.has(event.key)) noteIntent() }}
        // Un clic sur le conteneur lui-même, c’est sa barre de défilement.
        onPointerDown={(event) => { if (event.target === event.currentTarget) noteIntent() }}
        onScroll={() => {
          const element = scrollRef.current
          if (!element) return
          if (element.scrollHeight - element.scrollTop - element.clientHeight < 80) {
            stickToBottomRef.current = true
            setShowJump(false)
          } else if (Date.now() - intentAtRef.current < 1000) unstick()
        }}
      >
      <MailContext.Provider value={mailContext}>
      <MentionContext.Provider value={mentionValue}>
      <div className="messages-column" ref={columnRef}>
        {loading && (
          <div className="chat-loading" role="status" aria-live="polite">
            <div className="chat-skeleton" aria-hidden="true">
              <span className="is-bot" /><span className="is-user" /><span className="is-bot is-tall" /><span className="is-user is-short" /><span className="is-bot" />
            </div>
            <div className="chat-loading-label"><BotAvatar bot={bot} size={22} /><span>Ouverture de la conversation avec {bot.name}…</span></div>
          </div>
        )}
        {!loading && items.length === 0 && (
          <div className="chat-empty">
            <BotAvatar bot={bot} size={64} />
            <h2>{bot.name}</h2>
            <p>{bot.role}</p>
            <div className="suggestions">
              {['Que peux-tu faire ?', 'Fais-moi un point sur ta journée.', 'Qu’as-tu terminé récemment ?'].map((suggestion) => (
                <button key={suggestion} onClick={() => onSuggestion(suggestion)}>{suggestion}</button>
              ))}
            </div>
          </div>
        )}
        {!loading && items.map((message, index) => {
          const currentDay = messageDay(message.createdAt)
          const previousDay = index > 0 ? messageDay(items[index - 1].createdAt) : ''
          return (
            <div key={message.id}>
              {currentDay && currentDay !== previousDay && <div className="day-separator">{currentDay}</div>}
              <Message message={message} profile={profile} onOpenImages={openImages} onOpenDocument={openDocument} />
            </div>
          )
        })}
        {running && (!streaming || silentStream) && (
          <div className="working-row">
            <LiveAvatar bot={{ ...bot, status: bot.status === 'idle' || bot.status === 'done' ? 'working' : bot.status }} size={26} />
            <div><strong>{bot.name} · {statusLabel(bot.status === 'idle' ? 'working' : bot.status)}</strong>{activity && <span>{activity}</span>}</div>
            <span className="typing-dots"><i /><i /><i /></span>
          </div>
        )}
        <div ref={endRef} className="messages-end" />
      </div>
      </MentionContext.Provider>
      </MailContext.Provider>
      </div>
      {showJump && <button className="jump-latest" onClick={() => scrollToBottom(true)}><ArrowDown size={14} />Nouveaux messages</button>}
      {viewer && <MediaViewer viewer={viewer} onClose={closeViewer} onMove={moveViewer} />}
    </div>
  )
}
