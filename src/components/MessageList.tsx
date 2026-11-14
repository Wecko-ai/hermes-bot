import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, ArrowDown, ChevronDown } from 'lucide-react'
import ReactMarkdown, { type Components, type ExtraProps, type Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AgentMessage, Bot, ChatMessage } from '../types'
import { BotAvatar } from './BotAvatar'
import { LiveAvatar } from './LiveAvatar'
import { MediaEmbed, MediaViewer, mediaFailed, type ViewerState } from './MediaEmbed'
import { MailBlock, MailContext } from './MailCard'
import { QuestionsCard } from './QuestionsCard'
import { TweetCard } from './TweetCard'
import { findQuestions } from '../lib/questions'
import { findTweets, type TweetMatch } from '../lib/tweets'
import { isServablePath, mediaIndex, mediaRef, referencedFiles, remarkMedia, withoutUnfinishedTag, type MediaRef, type MediaSink } from '../lib/media'
import { normalizeHref } from '../lib/links'
import { findRanges } from '../lib/find'
import { mentionedSlug, mentionIndex as buildMentionIndex, remarkMentions } from '../lib/mentions'
import { approvedMailIds, MAIL_APPROVED_FENCE, MAIL_FENCE } from '../lib/mail'
import { stepIds } from '../lib/turns'
import { mayBecomeSilent } from '../lib/hermes'
import { messageDay, shortTime } from '../lib/time'

type OpenImages = (images: MediaRef[], index: number, version: string) => void

interface MediaContextValue {
  sink: MediaSink
  profile: string
  version: string
  streaming: boolean
  botCards: boolean
  openImage: (media: MediaRef) => void
  openDocument?: (media: MediaRef) => void
}

export interface MentionContextValue {
  index: Map<string, string | null>
  bots: Map<string, Bot>
  onOpenBot: (slug: string) => void
}

// The Markdown components stay at module level: a new identity on every render would remount
// the whole subtree, and a playing video would restart from zero while streaming.
const MediaContext = createContext<MediaContextValue | null>(null)
export const MentionContext = createContext<MentionContextValue | null>(null)
const TweetContext = createContext<TweetMatch[]>([])

function atTweet(tweets: TweetMatch[], offset: number | undefined): TweetMatch | undefined {
  return offset === undefined ? undefined : tweets.find((tweet) => offset >= tweet.start && offset < tweet.end)
}

function MarkdownLink({ href, children, node: _node, ...props }: ComponentProps<'a'> & ExtraProps) {
  const context = useContext(MediaContext)
  const mentions = useContext(MentionContext)
  const media = context?.sink.media[mediaIndex(href)]
  if (context && media) return <MediaEmbed media={media} profile={context.profile} version={context.version} onOpenImage={context.openImage} onOpenDocument={context.openDocument} />
  const mentioned = mentionedSlug(href)
  if (mentioned) return <button type="button" className="mention-chip" onClick={() => mentions?.onOpenBot(mentioned)}>{children}</button>
  return <a {...props} href={normalizeHref(href)} target="_blank" rel="noreferrer noopener">{children}</a>
}

/**
 * A paragraph made only of media becomes a gallery (several images in a row). Always a
 * `<p>`: changing the element when text arrives after a media would remount a playing video.
 */
function MarkdownParagraph({ node, children }: ComponentProps<'p'> & ExtraProps) {
  if (atTweet(useContext(TweetContext), node?.position?.start.offset)) return null
  const nodes = node?.children || []
  const media = nodes.filter((child) => child.type === 'element' && child.tagName === 'a' && mediaIndex(String(child.properties?.href ?? '')) >= 0)
  const onlyMedia = media.length > 0 && nodes.every((child) => media.includes(child)
    || (child.type === 'text' && !child.value.trim())
    || (child.type === 'element' && child.tagName === 'br'))
  return <p className={onlyMedia ? `media-group ${media.length === 1 ? 'is-single' : 'is-grid'}` : undefined}>{children}</p>
}

// A remote image that loads on its own can leak data through its URL.
function MarkdownImage({ src, alt }: ComponentProps<'img'> & ExtraProps) {
  const { t } = useTranslation()
  const url = typeof src === 'string' ? src : ''
  if (url.startsWith('data:image/') || url.startsWith('blob:')) return <img src={url} alt={alt || ''} />
  return <a href={url} target="_blank" rel="noreferrer noopener">{alt || t('messages.imageFallback')}</a>
}

type HastNode = { type: string; value?: string; children?: HastNode[] }

/** The text of a block as written, without its rendering. */
const hastText = (node: HastNode): string => node.type === 'text' ? node.value ?? '' : (node.children ?? []).map(hastText).join('')

/** Copies the command or code of a block, without the final line break: pasted in a terminal, it doesn't run on its own. */
function CodeCopy({ text }: { text: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }
  const label = copied ? t('messages.copiedCode') : t('messages.copyCode')
  return (
    <button type="button" className={`code-copy ${copied ? 'is-copied' : ''}`} aria-label={label} title={label} onClick={copy}>
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  )
}

/** A `hermes-mail` code block becomes the mail card to approve; any other block gets a copy button. */
function MarkdownPre({ node, children, ...props }: ComponentProps<'pre'> & ExtraProps) {
  const context = useContext(MediaContext)
  const tweet = atTweet(useContext(TweetContext), node?.position?.start.offset)
  if (tweet) return <TweetCard tweet={tweet} />
  const code = node?.children[0]
  const language = code?.type === 'element' && code.tagName === 'code' && Array.isArray(code.properties?.className) ? String(code.properties.className[0]) : ''
  if (context?.botCards !== false && code?.type === 'element' && (language === `language-${MAIL_FENCE}` || language === `language-${MAIL_APPROVED_FENCE}`)) {
    const source = code.children.map((child) => (child.type === 'text' ? child.value : '')).join('')
    return <MailBlock source={source} approvedBlock={language === `language-${MAIL_APPROVED_FENCE}`} streaming={Boolean(context?.streaming)} />
  }
  const text = code ? hastText(code as HastNode).replace(/\n$/, '') : ''
  return (
    <div className="code-block">
      <pre {...props}>{children}</pre>
      {text.trim() && !context?.streaming && <CodeCopy text={text} />}
    </div>
  )
}

const MARKDOWN_COMPONENTS: Components = { a: MarkdownLink, p: MarkdownParagraph, img: MarkdownImage, pre: MarkdownPre }

interface MarkdownProps {
  content: string
  profile: string
  /** Message id: versions the media URLs. */
  version: string
  streaming?: boolean
  /** Bot Chat media and interactive cards. Room text sets this false: only text, mentions and web links remain. */
  localMedia?: boolean
  /** Shows below the text the images, videos, sounds and PDFs the bot cites by path. */
  citedFiles?: boolean
  onOpenImages: OpenImages
  onOpenDocument?: (media: MediaRef) => void
}

interface CitedFilesProps {
  files: MediaRef[]
  profile: string
  version: string
  /** Images the user sent: no "cited files" title. */
  sent?: boolean
  onOpenImages: OpenImages
  onOpenDocument?: (media: MediaRef) => void
}

/** What the bot produced, readable without leaving the chat: thumbnails, players, PDFs beside. */
function CitedFiles({ files, profile, version, sent = false, onOpenImages, onOpenDocument }: CitedFilesProps) {
  const { t } = useTranslation()
  const openImage = (item: MediaRef) => {
    const images = files.filter((entry) => entry === item || (entry.kind === 'image' && !mediaFailed(profile, entry)))
    onOpenImages(images, Math.max(0, images.indexOf(item)), version)
  }
  return (
    <div className={sent ? 'cited-files is-sent' : 'cited-files'}>
      {!sent && <div className="cited-files-label">{t('messages.citedFile', { count: files.length })}</div>}
      <div className="cited-files-grid">
        {files.map((file) => <MediaEmbed key={file.path} media={file} profile={profile} version={version} onOpenImage={openImage} onOpenDocument={onOpenDocument} />)}
      </div>
    </div>
  )
}

export const Markdown = memo(function Markdown({ content, profile, version, streaming = false, localMedia = true, citedFiles = false, onOpenImages, onOpenDocument }: MarkdownProps) {
  const source = useMemo(() => (streaming ? withoutUnfinishedTag(content) : content), [content, streaming])
  const tweets = useMemo(() => localMedia && !streaming ? findTweets(source) : [], [source, streaming, localMedia])
  // One collector per text: the plugin stores the media there, the #media:<index> links point back to it.
  const sink = useMemo<MediaSink>(() => ({ media: [] }), [source])
  const mentionIndexValue = useContext(MentionContext)?.index
  const plugins = useMemo<NonNullable<Options['remarkPlugins']>>(() => [
    remarkGfm,
    ...(localMedia ? [[remarkMedia, sink] as [typeof remarkMedia, MediaSink]] : []),
    ...(mentionIndexValue ? [[remarkMentions, { index: mentionIndexValue }] as [typeof remarkMentions, { index: Map<string, string | null> }]] : []),
  ], [sink, mentionIndexValue, localMedia])
  const context = useMemo<MediaContextValue>(() => ({
    sink,
    profile,
    version,
    streaming,
    botCards: localMedia,
    openImage: (item) => {
      // All the readable images of the message, in order: the viewer moves from one slide to the next.
      const images = sink.media.filter((entry) => entry === item || (entry.kind === 'image' && isServablePath(entry.path) && !mediaFailed(profile, entry)))
      onOpenImages(images, Math.max(0, images.indexOf(item)), version)
    },
    openDocument: onOpenDocument,
  }), [sink, profile, version, streaming, localMedia, onOpenImages, onOpenDocument])
  // While streaming, a path can be cut off: the files show once the message is complete.
  const files = useMemo(() => (citedFiles && !streaming ? referencedFiles(source) : []), [citedFiles, streaming, source])
  return (
    <MediaContext.Provider value={context}>
      <TweetContext.Provider value={tweets}>
        <ReactMarkdown remarkPlugins={plugins} components={MARKDOWN_COMPONENTS}>{source}</ReactMarkdown>
      </TweetContext.Provider>
      {files.length > 0 && <CitedFiles files={files} profile={profile} version={version} onOpenImages={onOpenImages} onOpenDocument={onOpenDocument} />}
    </MediaContext.Provider>
  )
})

interface MessageProps {
  message: ChatMessage
  profile: string
  onOpenImages: OpenImages
  onOpenDocument: (media: MediaRef) => void
  /** The latest bot reply, nothing after it, no turn running: loose questions become a form. */
  askable?: boolean
}

// A message the user just sent fades in; a loaded or cached thread shows as is.
const isEntering = (message: ChatMessage) => message.id.startsWith('local-') && Date.now() - Date.parse(message.createdAt || '') < 2500

/** Bot named by Hermes (`iris`, `@iris`, `Dr. Foo`, `moxie@homelab`): the roster bot, or the name as is. */
function AgentName({ handle, fallback }: { handle: string; fallback?: string }) {
  const { t } = useTranslation()
  const mentions = useContext(MentionContext)
  const tag = handle.trim().replace(/^@/, '').toLowerCase()
  const slug = mentions?.index.get(tag) ?? mentions?.index.get(tag.split('@')[0]) ?? mentionedSlugOf(fallback || '', mentions?.index)
  const bot = slug ? mentions?.bots.get(slug) : undefined
  if (!bot) return <span className="agent-note-name">{fallback || handle.replace(/^@/, '')}</span>
  return (
    <button type="button" className="agent-note-name" onClick={() => mentions?.onOpenBot(bot.slug)} title={t('agentNotes.open', { name: bot.name })}>
      <BotAvatar bot={bot} size={16} />{bot.name}
    </button>
  )
}

function mentionedSlugOf(name: string, index?: Map<string, string | null>) {
  const form = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return form ? index?.get(form) ?? undefined : undefined
}

const AGENT_VERB_KEYS: Record<AgentMessage['kind'], string> = { message: 'agentNotes.message', reply: 'agentNotes.reply', 'no-reply': 'agentNotes.noReply' }

/** “Orion messaged Iris”: the verb opens the message, each name opens its bot. */
function AgentNote({ message, profile, onOpenImages, onOpenDocument }: MessageProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const agent = message.agent as AgentMessage
  return (
    <div className={`agent-note is-${agent.kind} ${open ? 'is-open' : ''}`}>
      <div className="agent-note-line">
        <AgentName handle={agent.from} fallback={agent.fromName} />{' '}
        <button type="button" className="agent-note-verb" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {t(AGENT_VERB_KEYS[agent.kind])}<ChevronDown size={11} aria-hidden="true" />
        </button>{' '}
        <AgentName handle={agent.to} />
        {message.createdAt && <>{' '}<time>{shortTime(message.createdAt)}</time></>}
      </div>
      {open && (
        <div className="agent-note-body message-content">
          {agent.text
            ? <Markdown content={agent.text} profile={profile} version={message.id} citedFiles onOpenImages={onOpenImages} onOpenDocument={onOpenDocument} />
            : <p className="agent-note-empty">{t('agentNotes.empty')}</p>}
        </div>
      )}
    </div>
  )
}

const Message = memo(function Message({ message, profile, onOpenImages, onOpenDocument, askable = false }: MessageProps) {
  const { t } = useTranslation()
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
  // "Questions ouvertes" at the end of a reply: answered from fields, not by retyping them.
  const questions = message.role === 'assistant' && !message.streaming ? findQuestions(message.content, askable) : null
  return (
    <article className={`message message-${message.role} ${message.streaming ? 'is-streaming' : ''} ${message.failed ? 'is-failed' : ''} ${isEntering(message) ? 'is-entering' : ''}`}>
      <div className="message-content">
        {questions
          ? <>
              {questions.before && <Markdown content={questions.before} profile={profile} version={message.id} citedFiles onOpenImages={onOpenImages} onOpenDocument={onOpenDocument} />}
              <QuestionsCard id={message.id} block={questions} />
              {questions.after && <Markdown content={questions.after} profile={profile} version={message.id} citedFiles onOpenImages={onOpenImages} onOpenDocument={onOpenDocument} />}
            </>
          : <Markdown content={message.content} profile={profile} version={message.id} streaming={message.streaming} citedFiles={message.role === 'assistant'} onOpenImages={onOpenImages} onOpenDocument={onOpenDocument} />}
        {message.images?.length ? <CitedFiles files={message.images.map(mediaRef)} profile={profile} version={message.id} sent onOpenImages={onOpenImages} onOpenDocument={onOpenDocument} /> : null}
        {message.streaming && <span className="stream-caret" />}
      </div>
      {!message.streaming && (
        <div className="message-meta">
          <span>{message.pending ? t('messages.sending') : message.failed ? t('messages.sendFailed') : shortTime(message.createdAt)}</span>
          {message.delivery && !message.failed && <span className={`message-delivery is-${message.delivery}`}>{message.delivery === 'priority' ? t('messages.priority') : t('messages.queued')}</span>}
          {message.role === 'assistant' && <button className="message-copy" aria-label={t('messages.copyReply')} onClick={copy}>{copied ? <Check size={13} /> : <Copy size={13} />}</button>}
        </div>
      )}
    </article>
  )
})

// Keys that scroll the thread: they count as a user gesture.
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '])

interface MessageListProps {
  bot: Bot
  bots: Bot[]
  messages: ChatMessage[]
  streaming: string
  /** Id of the current turn: the final message reuses it, so the bubble is not remounted. */
  streamKey: string
  running: boolean
  /** Action of the app in progress (sending, stopping, a tool): first choice for the working line. */
  activity: string
  /** What the bot is doing, from the turn's events (its last step, its current tool, its task list). */
  workText: string
  /** The local chat has no tools and no steps: its reply is streamed in its bubble as it is written. */
  streamReply?: boolean
  loading: boolean
  onSuggestion: (text: string) => void
  onOpenDocument: (profile: string, media: MediaRef) => void
  onOpenBot: (slug: string) => void
  /** Find in the conversation: matches are highlighted, `position` is the current one, `jump` changes on each Enter. */
  search?: { query: string; position: number; jump: number }
  onSearchCount?: (count: number) => void
}

// Only one list owns the page highlights at a time (the local chat keeps its own list mounted).
let highlightOwner: object | null = null
const supportsHighlights = () => typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined'

export function MessageList({ bot, bots, messages, streaming, streamKey, running, activity, workText, streamReply = false, loading, onSuggestion, onOpenDocument, onOpenBot, search, onSearchCount }: MessageListProps) {
  const { t } = useTranslation()
  const scrollRef = useRef<HTMLDivElement>(null)
  const columnRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const intentAtRef = useRef(0)
  const [showJump, setShowJump] = useState(false)
  const [viewer, setViewer] = useState<ViewerState | null>(null)
  // One message per turn: the bot's steps (text written before a tool call) fold into the working line,
  // and its reply is not streamed, it appears whole when the turn ends.
  const steps = useMemo(() => stepIds(messages, running, bot.slug), [messages, running, bot.slug])
  const visibleMessages = messages.filter((message) => !steps.has(message.id) && (message.agent || (!message.technical && message.role !== 'system' && message.role !== 'tool')))
  // A `NOREPLY` being written never shows: the bot at work is shown instead.
  const liveReply = streamReply && Boolean(streaming) && !mayBecomeSilent(streaming)
  const items = liveReply
    ? [...visibleMessages, { id: streamKey || 'live-stream', role: 'assistant', content: streaming, createdAt: null, streaming: true } satisfies ChatMessage]
    : visibleMessages
  const working = (running || Boolean(streaming)) && !liveReply
  // A mail card being written is never shown raw: the line says so until the card arrives.
  const caption = activity || (streaming.includes(MAIL_FENCE) ? t('mail.drafting') : workText) || t('messages.working', { name: bot.name })
  const count = items.length
  const profile = bot.slug
  const mailContext = useMemo(() => ({ profile, running, approved: approvedMailIds(messages), onApprove: onSuggestion }), [profile, running, messages, onSuggestion])
  // The roster is re-read every 30 s: as long as names don’t change, no message is re-parsed.
  const rosterKey = bots.map((item) => `${item.slug}\n${item.name}\n${item.avatar?.shape}\n${item.avatar?.color}`).join('\n')
  const mentionValue = useMemo<MentionContextValue>(() => ({
    index: buildMentionIndex(bots),
    // Static avatar in the thread: a named bot never animates here, even when working.
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
  // We follow the user’s intent, not the geometry: a programmatic scroll or a loading image
  // never detaches the thread; a wheel turn upward detaches it right away, before the scroll even happens.
  const noteIntent = () => { intentAtRef.current = Date.now() }
  const unstick = () => {
    stickToBottomRef.current = false
    setShowJump(true)
  }
  useEffect(() => {
    setViewer(null)
    scrollToBottom()
  }, [bot.slug])

  // Find in the conversation: ranges are rebuilt when the text changes, but the view only moves on Enter.
  const owner = useRef({}).current
  const lastJumpRef = useRef(search?.jump ?? 0)
  const flashRef = useRef<number | undefined>(undefined)
  const query = search?.query ?? ''
  const position = search?.position ?? -1
  const jump = search?.jump ?? 0
  useEffect(() => {
    const root = scrollRef.current
    const ranges = root && query.trim() ? findRanges(root, query) : []
    onSearchCount?.(ranges.length)
    const current = position >= 0 ? ranges[position] : undefined
    if (supportsHighlights()) {
      if (ranges.length) {
        highlightOwner = owner
        CSS.highlights.set('search-hit', new Highlight(...ranges.filter((range) => range !== current)))
        if (current) CSS.highlights.set('search-current', new Highlight(current))
        else CSS.highlights.delete('search-current')
      } else if (highlightOwner === owner) {
        CSS.highlights.delete('search-hit')
        CSS.highlights.delete('search-current')
      }
    }
    if (jump === lastJumpRef.current) return
    lastJumpRef.current = jump
    if (!root || !current) return
    // Detach from the bottom first, or the thread would pull the view back; the scroll event re-attaches it if the match is at the end.
    stickToBottomRef.current = false
    setShowJump(true)
    const box = current.getBoundingClientRect()
    root.scrollTop += box.top - root.getBoundingClientRect().top - root.clientHeight / 2 + box.height / 2
    if (!supportsHighlights()) {
      const message = current.startContainer.parentElement?.closest('.message')
      message?.classList.add('search-flash')
      window.clearTimeout(flashRef.current)
      flashRef.current = window.setTimeout(() => message?.classList.remove('search-flash'), 1400)
    }
  }, [query, position, jump, items, streaming, loading])
  useEffect(() => () => {
    if (highlightOwner === owner && supportsHighlights()) {
      CSS.highlights.delete('search-hit')
      CSS.highlights.delete('search-current')
    }
  }, [])
  useEffect(() => {
    if (stickToBottomRef.current) followBottom()
  }, [count, streaming, running, loading])
  // An image or video that finishes loading makes the thread taller: we stay at the bottom only if the user was there.
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
        // A click on the container itself is a click on its scrollbar.
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
            <div className="chat-loading-label"><BotAvatar bot={bot} size={22} /><span>{t('messages.opening', { name: bot.name })}</span></div>
          </div>
        )}
        {!loading && items.length === 0 && (
          <div className="chat-empty">
            <BotAvatar bot={bot} size={64} />
            <h2>{bot.name}</h2>
            <p>{bot.role}</p>
            {/* A bot at work on an empty chat (a new bot introducing itself): no suggestions under its working line. */}
            {!working && <div className="suggestions">
              {[t('messages.suggestionCapabilities'), t('messages.suggestionDay'), t('messages.suggestionRecent')].map((suggestion) => (
                <button key={suggestion} onClick={() => onSuggestion(suggestion)}>{suggestion}</button>
              ))}
            </div>}
          </div>
        )}
        {!loading && items.map((message, index) => {
          const currentDay = messageDay(message.createdAt)
          const previousDay = index > 0 ? messageDay(items[index - 1].createdAt) : ''
          return (
            <div key={message.id}>
              {currentDay && currentDay !== previousDay && <div className="day-separator">{currentDay}</div>}
              <Message message={message} profile={profile} onOpenImages={openImages} onOpenDocument={openDocument} askable={index === items.length - 1 && !working && message.role === 'assistant'} />
            </div>
          )
        })}
        {working && (
          <div className="working-row" role="status" aria-live="polite">
            <LiveAvatar bot={{ ...bot, status: bot.status === 'idle' || bot.status === 'done' ? 'working' : bot.status }} size={24} />
            {/* A new caption slides in; the sheen runs over whatever is written. */}
            <span className="working-caption" key={caption} title={caption}>{caption}</span>
          </div>
        )}
        <div ref={endRef} className="messages-end" />
      </div>
      </MentionContext.Provider>
      </MailContext.Provider>
      </div>
      {showJump && <button type="button" className="jump-latest" aria-label={t('messages.newMessages')} title={t('messages.newMessages')} onClick={() => scrollToBottom()}><ArrowDown size={20} strokeWidth={2.25} aria-hidden="true" /></button>}
      {viewer && <MediaViewer viewer={viewer} onClose={closeViewer} onMove={moveViewer} />}
    </div>
  )
}
