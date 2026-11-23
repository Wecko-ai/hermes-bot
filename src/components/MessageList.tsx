import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, ArrowDown, ChevronDown, Volume2 } from 'lucide-react'
import { autoRouteDisplay } from '../lib/auto-route-label'
import { answeredByMessage, answeredLabel, answeredTitle, currentAnswered } from '../lib/turn-model'
import type { AnsweredBy } from '../types'
import ReactMarkdown, { type Components, type ExtraProps, type Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AgentMessage, Bot, ChatMessage } from '../types'
import { BotAvatar } from './BotAvatar'
import { ViewEmpty } from './ViewEmpty'
import { LiveAvatar } from './LiveAvatar'
import { MediaEmbed, MediaViewer, mediaFailed, type ViewerState } from './MediaEmbed'
import { MailBlock, MailContext } from './MailCard'
import { DraftBlock, DraftContext } from './DraftCard'
import { ProgressTurn } from './ProgressTurn'
import { QuestionsCard } from './QuestionsCard'
import { TweetCard } from './TweetCard'
import { PlacesBlock } from './PlaceResultsCard'
import { VaultFormBlock } from './SecureVaultFormCard'
import { VAULT_FORM_FENCE } from '../lib/vault-form'
import { findQuestions, parseAnswersPrompt } from '../lib/questions'
import { findTweets, type TweetMatch } from '../lib/tweets'
import { isServablePath, mediaIndex, mediaRef, referencedFiles, remarkMedia, withoutUnfinishedTag, type MediaRef, type MediaSink } from '../lib/media'
import { normalizeHref } from '../lib/links'
import { completedMessageStamp, findRanges } from '../lib/find'
import { mentionedSlug, mentionIndex as buildMentionIndex, remarkMentions } from '../lib/mentions'
import { approvedMailIds, MAIL_APPROVED_FENCE, MAIL_FENCE, withoutMailInstruction } from '../lib/mail'
import { approvedDraftIds, DRAFT_APPROVED_FENCE, DRAFT_FENCE, withoutDraftInstruction } from '../lib/draft'
import { threadItems } from '../lib/progress'
import { getSettings } from '../lib/settings'
import { PLACES_FENCE } from '../lib/places'
import { replyAnnouncement } from '../lib/local-chat-turn'
import { nextStick } from '../lib/scroll-stick'
import { useScrollIntent } from '../lib/use-scroll-intent'
import { mayBecomeSilent } from '../lib/hermes'
import { messageDay, shortTime } from '../lib/time'
import { useAppConfig } from '../lib/app-config'
import { guessLanguage, toSpokenText } from '../lib/spoken-text'

type OpenImages = (images: MediaRef[], index: number, version: string) => void

interface MediaContextValue {
  sink: MediaSink
  profile: string
  version: string
  streaming: boolean
  botCards: boolean
  /** Approved-mail fences become a receipt only when this is `user`. */
  role?: ChatMessage['role']
  openImage: (media: MediaRef) => void
  openDocument?: (media: MediaRef) => void
  onVaultFormDone?: (message: string) => void
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
  // `data:` and `blob:` never arrive: the markdown url transform empties them before this runs.
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

/** A fenced block becomes a card when its language says so; any other block gets a copy button. */
function MarkdownPre({ node, children, ...props }: ComponentProps<'pre'> & ExtraProps) {
  const context = useContext(MediaContext)
  const tweet = atTweet(useContext(TweetContext), node?.position?.start.offset)
  if (tweet) return <TweetCard tweet={tweet} />
  const code = node?.children[0]
  const language = code?.type === 'element' && code.tagName === 'code' && Array.isArray(code.properties?.className) ? String(code.properties.className[0]) : ''
  const source = code?.type === 'element' ? code.children.map((child) => (child.type === 'text' ? child.value : '')).join('') : ''
  // An approved fence is a receipt only in the user's message. A note between bots keeps every fence as code.
  if (context?.botCards !== false && code?.type === 'element' && source && (language === `language-${MAIL_FENCE}` || language === `language-${MAIL_APPROVED_FENCE}`) && !(language === `language-${MAIL_APPROVED_FENCE}` && context?.role !== 'user')) {
    return <MailBlock source={source} approvedBlock={language === `language-${MAIL_APPROVED_FENCE}`} streaming={Boolean(context?.streaming)} role={context?.role} />
  }
  if (context?.botCards !== false && code?.type === 'element' && source && (language === `language-${DRAFT_FENCE}` || language === `language-${DRAFT_APPROVED_FENCE}`) && !(language === `language-${DRAFT_APPROVED_FENCE}` && context?.role !== 'user')) {
    return <DraftBlock source={source} approvedBlock={language === `language-${DRAFT_APPROVED_FENCE}`} streaming={Boolean(context?.streaming)} role={context?.role} />
  }
  // Places cards, like mail cards, stay inert until the fence is complete and valid.
  if (context && context.botCards !== false && code?.type === 'element' && language === `language-${PLACES_FENCE}`) {
    return <PlacesBlock source={source} profile={context.profile} version={context.version} streaming={Boolean(context.streaming)} />
  }
  if (context && context.botCards !== false && code?.type === 'element' && language === `language-${VAULT_FORM_FENCE}` && context.onVaultFormDone) {
    return <VaultFormBlock source={source} profile={context.profile} streaming={Boolean(context.streaming)} onDone={context.onVaultFormDone} />
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
  /** Approved-mail fences become a sent receipt only for a user message. */
  role?: ChatMessage['role']
  /** Mail cards, tweets and the other interactive blocks. Defaults to `localMedia`. */
  botCards?: boolean
  onOpenImages: OpenImages
  onOpenDocument?: (media: MediaRef) => void
  onVaultFormDone?: (message: string) => void
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

export const Markdown = memo(function Markdown({ content, profile, version, streaming = false, localMedia = true, botCards, role, citedFiles = false, onOpenImages, onOpenDocument, onVaultFormDone }: MarkdownProps) {
  const cards = botCards ?? localMedia
  const source = useMemo(() => (streaming ? withoutUnfinishedTag(content) : content), [content, streaming])
  const tweets = useMemo(() => cards && !streaming ? findTweets(source) : [], [source, streaming, cards])
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
    botCards: cards,
    role,
    openImage: (item) => {
      // All the readable images of the message, in order: the viewer moves from one slide to the next.
      const images = sink.media.filter((entry) => entry === item || (entry.kind === 'image' && isServablePath(entry.path) && !mediaFailed(profile, entry)))
      onOpenImages(images, Math.max(0, images.indexOf(item)), version)
    },
    openDocument: onOpenDocument,
    onVaultFormDone,
  }), [sink, profile, version, streaming, cards, role, onOpenImages, onOpenDocument, onVaultFormDone])
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
  onVaultFormDone?: (message: string) => void
  /** The latest bot reply, nothing after it, no turn running: loose questions become a form. */
  askable?: boolean
  /** Auto mode: the model the router picked for this turn, shown as a small label in the meta. */
  autoRoute?: ChatMessage['autoRoute']
  /** Hermes left the selected model: the model that actually answered. */
  answeredBy?: AnsweredBy
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
export function AgentNote({ message, profile, onOpenImages, onOpenDocument, initiallyOpen = false }: MessageProps & { initiallyOpen?: boolean }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(initiallyOpen)
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
            ? <Markdown content={agent.text} profile={profile} version={message.id} citedFiles botCards={false} role="assistant" onOpenImages={onOpenImages} onOpenDocument={onOpenDocument} />
            : <p className="agent-note-empty">{t('agentNotes.empty')}</p>}
        </div>
      )}
    </div>
  )
}

type AutoRoute = NonNullable<ChatMessage['autoRoute']>

/** Readable model and provider for a routed turn: « GPT 5.6 Sol · Cursor ». */
export function autoRouteModel(route: AutoRoute) {
  return autoRouteDisplay(route.chosen, route.label)
}

/** Tooltip of an Auto label: the router's category and reason, never prompt text. */
export function autoRouteTitle(route: AutoRoute) {
  return [route.chosen, route.category, route.reason].filter(Boolean).join(' · ')
}

/**
 * Auto routing of each turn, keyed by message id: a user message carries the router's pick, and the
 * replies that follow it (until the next user message) show the same model. A user message whose
 * reply is already there drops its own badge, so the label sits once, on the answer.
 */
export function autoRoutesByMessage(messages: ChatMessage[]) {
  const replies = new Map<string, AutoRoute>()
  const answered = new Set<string>()
  let route: AutoRoute | undefined
  let userId = ''
  for (const message of messages) {
    if (message.role === 'user') {
      route = message.autoRoute
      userId = message.id
    } else if (message.role === 'assistant' && !message.progress && route) {
      replies.set(message.id, route)
      answered.add(userId)
    }
  }
  return { replies, answered }
}

/** The routed model of the turn in progress: the last user message's pick. */
export function currentAutoRoute(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') return messages[index].autoRoute
  }
  return undefined
}

function AnsweredLabel({ answered, className }: { answered: AnsweredBy; className: string }) {
  const { t } = useTranslation()
  return (
    <span className={className} title={answeredTitle(answered)}>
      {answeredLabel(answered, t('models.fallbackMark'))}
    </span>
  )
}

function AutoRouteLabel({ route, className }: { route: AutoRoute; className: string }) {
  const { t } = useTranslation()
  const mode = route.mode === 'auto-free' ? t('autoRouter.modeFree') : t('autoRouter.mode')
  return (
    <span className={className} title={autoRouteTitle(route)}>
      {t('autoRouter.label', { mode, model: autoRouteModel(route) })}
    </span>
  )
}

const Message = memo(function Message({ message, profile, onOpenImages, onOpenDocument, onVaultFormDone, askable = false, autoRoute, answeredBy }: MessageProps) {
  const { t, i18n } = useTranslation()
  const replyListen = useAppConfig().ui.replyListenButton
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(message.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }
  const listen = () => {
    const speech = window.hermesBot?.speech
    if (!speech || message.role !== 'assistant') return
    const language = guessLanguage(message.content, i18n.language.startsWith('fr') ? 'fr' : 'en')
    const spoken = toSpokenText(message.content, { language, maxSentences: 8 })
    if (!spoken.text.trim()) return
    void speech.say({
      id: Date.now() % 1_000_000_000,
      text: spoken.text,
      language: language === 'fr' ? 'fr-FR' : 'en-US',
    })
  }
  if (message.agent) return <AgentNote message={message} profile={profile} onOpenImages={onOpenImages} onOpenDocument={onOpenDocument} />
  if (message.role === 'system' || message.role === 'tool') {
    return <div className="system-message">{message.content}</div>
  }
  // The model instruction on an approved mail stays in the stored text and out of the bubble.
  const shown = message.role === 'user' ? withoutDraftInstruction(withoutMailInstruction(message.content)) : message.content
  // "Questions ouvertes" at the end of a reply: answered from fields, not by retyping them.
  const questions = message.role === 'assistant' && !message.streaming ? findQuestions(message.content, askable) : null
  // Answers sent from a questions card: a tight question / answer list, not the raw numbered text.
  const sentAnswers = message.role === 'user' ? parseAnswersPrompt(message.content) : null
  return (
    <article className={`message message-${message.role} ${message.streaming ? 'is-streaming' : ''} ${message.failed ? 'is-failed' : ''} ${isEntering(message) ? 'is-entering' : ''}`}>
      <div className="message-content">
        {sentAnswers
          ? <dl className="sent-answers" aria-label={sentAnswers.intro}>
              {sentAnswers.items.map((item) => (
                <div key={item.number} className="sent-answer">
                  <dt>{item.question}</dt>
                  <dd>{item.answer}</dd>
                </div>
              ))}
            </dl>
          : questions
          ? <>
              {questions.before && <Markdown content={questions.before} profile={profile} version={message.id} citedFiles onOpenImages={onOpenImages} onOpenDocument={onOpenDocument} onVaultFormDone={onVaultFormDone} />}
              <QuestionsCard id={message.id} block={questions} />
              {questions.after && <Markdown content={questions.after} profile={profile} version={message.id} citedFiles onOpenImages={onOpenImages} onOpenDocument={onOpenDocument} onVaultFormDone={onVaultFormDone} />}
            </>
          : message.streaming
          ? <div className="stream-plain" style={{ whiteSpace: 'pre-wrap' }} aria-hidden="true">{message.content}</div>
          : <Markdown content={shown} profile={profile} version={message.id} role={message.role} citedFiles={message.role === 'assistant'} onOpenImages={onOpenImages} onOpenDocument={onOpenDocument} onVaultFormDone={onVaultFormDone} />}
        {message.images?.length ? <CitedFiles files={message.images.map(mediaRef)} profile={profile} version={message.id} sent onOpenImages={onOpenImages} onOpenDocument={onOpenDocument} /> : null}
        {message.streaming && <span className="stream-caret" />}
      </div>
      {!message.streaming && (
        <div className="message-meta">
          <span>{message.pending ? t('messages.sending') : message.failed ? t('messages.sendFailed') : shortTime(message.createdAt)}</span>
          {message.delivery && !message.failed && <span className={`message-delivery is-${message.delivery}`}>{message.delivery === 'priority' ? t('messages.priority') : t('messages.queued')}</span>}
          {answeredBy
            ? <AnsweredLabel answered={answeredBy} className="message-auto-route" />
            : autoRoute && <AutoRouteLabel route={autoRoute} className="message-auto-route" />}
          {message.role === 'assistant' && (
            <>
              <button type="button" className="message-copy" aria-label={t('messages.copyReply')} onClick={copy}>{copied ? <Check size={13} /> : <Copy size={13} />}</button>
              {replyListen && (
                <button type="button" className="message-copy" aria-label={t('messages.listenReply')} onClick={listen}><Volume2 size={13} aria-hidden="true" /></button>
              )}
            </>
          )}
        </div>
      )}
    </article>
  )
})

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
  onSuggestion: (text: string) => Promise<boolean | void> | boolean | void
  onOpenDocument: (profile: string, media: MediaRef) => void
  onVaultFormDone?: (message: string) => void
  onOpenBot: (slug: string) => void
  /** Find in the conversation: matches are highlighted, `position` is the current one, `jump` changes on each Enter. */
  search?: { query: string; position: number; jump: number }
  onSearchCount?: (count: number) => void
  /** Milestone bubbles in the thread; defaults to the Conversations setting. */
  progressInThread?: boolean
}

// Only one list owns the page highlights at a time (the local chat keeps its own list mounted).
let highlightOwner: object | null = null
const supportsHighlights = () => typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined'

export function MessageList({ bot, bots, messages, streaming, streamKey, running, activity, workText, streamReply = false, loading, onSuggestion, onOpenDocument, onVaultFormDone, onOpenBot, search, onSearchCount, progressInThread = getSettings().progressInThread }: MessageListProps) {
  const { t } = useTranslation()
  const scrollRef = useRef<HTMLDivElement>(null)
  const columnRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  // Latest wheel delta. A wheel-up stays negative until the user scrolls downward, so a
  // near-bottom scroll event cannot pin the thread again on its own.
  const wheelDeltaRef = useRef(0)
  const scrollTopRef = useRef(0)
  // A scroll upward without a gesture is the layout: it must not detach the thread from the bottom.
  const intent = useScrollIntent()
  const [showJump, setShowJump] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const wasStreamingRef = useRef(false)
  const announcedIdRef = useRef('')
  const [viewer, setViewer] = useState<ViewerState | null>(null)
  // One message per turn: the bot's steps (text written before a tool call) fold into the working line,
  // and its reply is not streamed, it appears whole when the turn ends.
  const thread = useMemo(() => threadItems(messages, running, bot.slug, progressInThread), [messages, running, bot.slug, progressInThread])
  // A `NOREPLY` being written never shows: the bot at work is shown instead.
  const liveReply = streamReply && Boolean(streaming) && !mayBecomeSilent(streaming)
  const items = liveReply
    ? [...thread, { kind: 'message' as const, message: { id: streamKey || 'live-stream', role: 'assistant', content: streaming, createdAt: null, streaming: true } satisfies ChatMessage }]
    : thread
  const working = (running || Boolean(streaming)) && !liveReply
  const autoRoutes = useMemo(() => autoRoutesByMessage(messages), [messages])
  const answeredTurns = useMemo(() => answeredByMessage(messages), [messages])
  const liveRoute = working ? currentAutoRoute(messages) : undefined
  const liveAnswered = working ? currentAnswered(messages) : undefined
  const routeFor = (message: ChatMessage) => message.role === 'assistant'
    ? (message.streaming || message.progress ? undefined : autoRoutes.replies.get(message.id))
    : message.role === 'user' && message.autoRoute && !autoRoutes.answered.has(message.id) && !(working && message.autoRoute === liveRoute)
      ? message.autoRoute
      : undefined
  const answeredFor = (message: ChatMessage) => message.role === 'assistant' && !message.streaming && !message.progress
    ? message.answeredBy ?? answeredTurns.get(message.id)
    : undefined
  // A card being written is never shown raw: the line says so until the card arrives.
  const caption = activity || (streaming.includes(MAIL_FENCE) ? t('mail.drafting') : streaming.includes(DRAFT_FENCE) ? t('draft.drafting') : streaming.includes(PLACES_FENCE) ? t('places.drafting') : workText) || t('messages.working', { name: bot.name })
  const count = items.length
  const profile = bot.slug
  const mailContext = useMemo(() => ({ profile, running, approved: approvedMailIds(messages), onApprove: onSuggestion }), [profile, running, messages, onSuggestion])
  const draftContext = useMemo(() => ({ profile, running, approved: approvedDraftIds(messages), onApprove: onSuggestion }), [profile, running, messages, onSuggestion])
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
  const applyStick = (deltaY: number) => {
    const element = scrollRef.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    const next = nextStick(stickToBottomRef.current, deltaY, distance)
    stickToBottomRef.current = next
    setShowJump((current) => (current === !next ? current : !next))
  }
  const scrollToBottom = (smooth = false) => {
    stickToBottomRef.current = true
    wheelDeltaRef.current = 0
    intent.clear()
    setShowJump(false)
    endRef.current?.scrollIntoView({ block: 'end', behavior: smooth ? 'smooth' : 'instant' })
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
  // Finished messages only. The streaming bubble is excluded, so a token does not walk the thread.
  const flatMessages = useMemo(() => items.flatMap((item) => item.kind === 'message' ? [item.message] : [...item.progress, ...(item.answer ? [item.answer] : [])]), [items])
  const completedStamp = completedMessageStamp(flatMessages)
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
    // Detach from the bottom first. A later downward scroll onto the edge pins again; being near it does not.
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
  }, [query, position, jump, completedStamp, loading])
  // Local chat: announce the finished reply once. Token updates never replace this text.
  useEffect(() => {
    if (!streamReply) return
    if (streaming) {
      wasStreamingRef.current = true
      announcedIdRef.current = streamKey
      return
    }
    if (!wasStreamingRef.current) return
    wasStreamingRef.current = false
    const finished = flatMessages.find((message) => message.id === announcedIdRef.current && message.role === 'assistant' && !message.streaming)
    const speech = replyAnnouncement(false, finished?.content ?? '')
    if (speech) setAnnouncement(speech)
  }, [streamReply, streaming, streamKey])
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
  // The viewport too: a window that opens taller or a composer that grows must keep the last line in view.
  useEffect(() => {
    const column = columnRef.current
    const viewport = scrollRef.current
    if (!column || !viewport || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (stickToBottomRef.current) followBottom()
    })
    observer.observe(column)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="messages-viewport">
      {streamReply && <div className="visually-hidden" aria-live="polite">{announcement}</div>}
      <div
        className="messages-scroll"
        ref={scrollRef}
        {...intent.handlers}
        onWheel={(event) => {
          intent.noteIntent()
          wheelDeltaRef.current = event.deltaY
          applyStick(event.deltaY)
        }}
        onScroll={() => {
          const element = scrollRef.current
          if (!element) return
          const moved = element.scrollTop - scrollTopRef.current
          scrollTopRef.current = element.scrollTop
          // Upward with no gesture: the layout clamped scrollTop. A pinned thread stays at the bottom.
          if (moved < 0 && !intent.userScrolling()) {
            if (stickToBottomRef.current) followBottom()
            return
          }
          // A wheel-up wins until the user actually scrolls down. Near the bottom is not enough.
          const deltaY = wheelDeltaRef.current < 0 && moved <= 0 ? wheelDeltaRef.current : moved
          if (moved > 0) wheelDeltaRef.current = 0
          applyStick(deltaY)
        }}
      >
      <MailContext.Provider value={mailContext}>
      <DraftContext.Provider value={draftContext}>
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
          <ViewEmpty
            variant="hero"
            icon={<BotAvatar bot={bot} size={64} />}
            title={bot.name}
            description={bot.role}
            action={!working ? (
              <div className="suggestions">
                {[t('messages.suggestionCapabilities'), t('messages.suggestionDay'), t('messages.suggestionRecent')].map((suggestion) => (
                  <button key={suggestion} type="button" onClick={() => onSuggestion(suggestion)}>{suggestion}</button>
                ))}
              </div>
            ) : undefined}
          />
        )}
        {!loading && items.map((row, index) => {
          const stamp = (message: ChatMessage | undefined) => message ? messageDay(message.createdAt) : ''
          const rowStamp = (entry: typeof row) => entry.kind === 'message' ? stamp(entry.message) : stamp(entry.answer ?? entry.progress.at(-1))
          const currentDay = rowStamp(row)
          const previousDay = index > 0 ? rowStamp(items[index - 1]) : ''
          const renderMessage = (message: ChatMessage, askable: boolean) => (
            <Message message={message} profile={profile} onOpenImages={openImages} onOpenDocument={openDocument} onVaultFormDone={onVaultFormDone} askable={askable} autoRoute={answeredFor(message) ? undefined : routeFor(message)} answeredBy={answeredFor(message)} />
          )
          if (row.kind === 'turn') {
            const lastAssistant = !working && index === items.length - 1
            return (
              <div key={`turn-${row.progress[0]?.id ?? row.answer?.id ?? index}`}>
                {currentDay && currentDay !== previousDay && <div className="day-separator">{currentDay}</div>}
                <ProgressTurn
                  progress={row.progress}
                  answer={row.answer}
                  collapsed={row.collapsed}
                  renderAnswer={(message) => renderMessage(message, lastAssistant && Boolean(row.answer))}
                />
              </div>
            )
          }
          const message = row.message
          return (
            <div key={message.id}>
              {currentDay && currentDay !== previousDay && <div className="day-separator">{currentDay}</div>}
              {renderMessage(message, index === items.length - 1 && !working && message.role === 'assistant')}
            </div>
          )
        })}
        {working && (
          <div className="working-row" role="status" aria-live="polite">
            <LiveAvatar bot={{ ...bot, status: bot.status === 'idle' || bot.status === 'done' ? 'working' : bot.status }} size={24} />
            {/* A new caption slides in; the sheen runs over whatever is written. */}
            <span className="working-caption" key={caption} title={caption}>{caption}</span>
            {liveAnswered
              ? <AnsweredLabel answered={liveAnswered} className="working-auto-route" />
              : liveRoute && <AutoRouteLabel route={liveRoute} className="working-auto-route" />}
          </div>
        )}
        <div ref={endRef} className="messages-end" />
      </div>
      </MentionContext.Provider>
      </DraftContext.Provider>
      </MailContext.Provider>
      </div>
      {showJump && <button type="button" className="jump-latest" aria-label={t('messages.newMessages')} title={t('messages.newMessages')} onClick={() => scrollToBottom()}><ArrowDown size={20} strokeWidth={2.25} aria-hidden="true" /></button>}
      {viewer && <MediaViewer viewer={viewer} onClose={closeViewer} onMove={moveViewer} />}
    </div>
  )
}
