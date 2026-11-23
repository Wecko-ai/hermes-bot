import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { AlertCircle, X } from 'lucide-react'
import type { AnsweredBy, Bot, ChatMessage, ModelOption } from './types'
import { answerPrompt, attachFile, attachImageBytes, checkModelRoute, checkModelRoutes, HermesClient, HermesRpcError, interruptChat, isSilentMessage, liveTurnStatus, loadContextBreakdown, loadLiveStatuses, loadModelOptions, loadRoster, loadRoutines, loadSessionEvents, loadUsage, loadUsageHistory, mergeUsage, openChat, parsePendingPrompt, parseUsage, steerSession, submitPrompt, switchModel, withoutSilentMarkers, type ActiveChat, type PendingPrompt, type ServerRequest } from './lib/hermes'
import { enrichRoutines } from './lib/routines'
import { mergeRoster } from './lib/activity'
import { hasBackground, loadBackgroundWork, loadChatBackground, loadSubagentTail, mergeBackground, sameBackground } from './lib/background'
import { chatBackground, isSubagentActive, type SubagentRow } from './lib/subagents'
import { subagentHistory } from './lib/subagent-history'
import type { AgentProcess } from './lib/agent-process'
import { ensureAppConfig, getAppConfig, useAppConfig } from './lib/app-config'
import { touchLibraryPage, type LibraryPage } from './lib/pages-library'
import { toolLabel, workLine } from './lib/work-summary'
import { autoCompactionPoint, blocksSending, compactingTokens, evaluateGuard, limitTokens, parseCompressResult, readCompaction, type CompressionValues } from './lib/compaction'
import { freshNotes, markMessageFailed, resolveSyncedMessages, useChatStore, useRequestsStore, useRosterStore, useSubagentsStore, useRoomStore, roomCancelId, clearRoomCancel, roomRenameEventId, clearRoomRename, roomDisbandCancelId, clearRoomDisband, type RoomSupport } from './store'
import { createRoom, disbandRoom, listRooms, loadRoomCapabilities, renameRoom, roomActionErrorKey, roomCanDisband, roomCanRename, planRoomSend, readRoom, ROOM_LOG_STALLED, roomMethodMissing, roomPreview, roomSendNotAdmitted, sendRoomMessage, setRoomContext, stopRoom, validateRoomBots, type Room, type RoomCapabilities, type RoomDriverStatus, type RoomEvent } from './lib/rooms'
import { gatewayContextPatch, roomRoutingMode, roomSendAllowed, setRoomRoutingMode, type RoomRoutingMode } from './lib/room-routing'
import { teamFeedFromCaches } from './lib/team-feed'
import { TeamView } from './components/TeamView'
import { RoomRoutingDialog } from './components/RoomRoutingDialog'
import { chipModelLabel, compactNumber, modelLabel } from './lib/model'
import { ModelPicker } from './components/ModelPicker'
import { demoChat, demoData, demoRoomDriver, demoRoomEvents, newDemoRoom, type DemoLanguage } from './lib/demo'
import { Sidebar } from './components/Sidebar'
import { ChatView } from './components/ChatView'
import { RoomView } from './components/RoomView'
import { NewRoomDialog } from './components/NewRoomDialog'
import { CommandPalette } from './components/CommandPalette'
import { BOT_RAIL_TAB, DetailsPanel, type DetailsTabRequest } from './components/DetailsPanel'
import type { OpenDocument } from './components/DocumentView'
import type { UsageDetails } from './components/UsageTab'
import { Login } from './components/Login'
import { LoadingScreen } from './components/LoadingScreen'
import { LocalChatView } from './components/LocalChatView'
import { ServerRequestDialog } from './components/ServerRequestDialog'
import { BrowserVaultDialog } from './components/BrowserVaultDialog'
import { respondBrowserVault, subscribeBrowserVaultRequests, takeUnseenNotices, type BrowserVaultNotice } from './lib/browser-vault'
import { SSO_NAMES, ssoSteerText, type SsoProvider } from './lib/sso'
import { requestContext } from './lib/request-context'
import { attachmentLabel, readDataUrl, type PendingAttachment } from './lib/attachments'
import { withMentionNote } from './lib/mentions'
import { agentChatMessages, agentMessagesFromEvent } from './lib/inter-agent'
import { cavemanApiText, loadModes, modeApiText, voiceApiText, type ChatMode } from './lib/modes'
import { progressBubbleText, shouldRecordProgress } from './lib/progress'
import { expandToolMessage, parseToolTranscript, transcriptStepLabel } from './lib/tool-transcript'
import { serverApprovalPrompt } from './lib/approval'
import { turnStyleNotes } from './lib/turn-style'
import { VoiceOverlay } from './components/VoiceOverlay'
import { VoiceSession } from './lib/voice-session'
import { createSpeechEngine } from './lib/speech-engines'
import { createDictationEngine } from './lib/dictation-engines'
import { priorityApiText, type DeliveryMode } from './lib/delivery'
import { LOCAL_CHAT_SLUG, chooseLocalModel, loadLocalModels, localChatBot, type LocalModels } from './lib/local-chat'
import { probeModel } from './lib/model-probe'
import { pullSharedSettingsSoon, syncSharedSettings } from './lib/shared-settings'
import { botActionError, runBotAction, type BotAction } from './lib/bot-actions'
import { createBot, createdBotEntry, loadProfileNames, withCreatedBot, type BotDraft } from './lib/bot-create'
import { introduceDemoBot, kickOffNewBot, type FreshBot, type KickoffTurnSubmit } from './lib/bot-onboarding'
import { NewBotDialog, NewBotRetry } from './components/NewBotDialog'
import type { MediaRef } from './lib/media'
import { SettingsDialog, type SettingsTab } from './components/SettingsDialog'
import { BotEditDialog } from './components/BotEditDialog'
import { ImportBotDialog } from './components/ImportBotDialog'
import { loadMemorySummary, sharedMemoryApiText } from './lib/shared-memory'
import { i18n, resolveLanguage } from './i18n'
import { dictationLanguageCode, getSettings, selectableModels, updateSettings, useSettings, type ThemeChoice } from './lib/settings'
import { createReconnector, HEARTBEAT_MS, HEARTBEAT_TIMEOUT_MS } from './lib/reconnect'
import { forgetTurn, noteTurnEvent, noteTurnInput, noteTurnReply, noteTurnSilence, recordedReply, notificationBody, notificationForRequest, notificationForStatus, notificationForWaiting, shouldNotify, turnEndsFromRows, turnForUser, watchWhileHidden, type NotificationKind } from './lib/notifications'
import { enqueuePushRelay } from './lib/push-relay'
import { parseDraftBlock, DRAFT_FENCE } from './lib/draft'
import { heartbeatFailureClosesSocket, isPermissionDenied } from './lib/gateway-errors'
import { AUTO_FREE_MODEL_SENTINEL, appendAutoRouteLog, autoModeFor, autoRouterEnabled, decideAutoRoute, defaultAutoPicker, fallbackLabel, isAutoModel, pickerModelAfterRoute, quotaErrorHint } from './lib/auto-router'
import { autoCompactKey, fallbackRouteId, parseModelFallback, shouldCheckAutoCompact } from './lib/auto-context'
import { answeredFromEvent, answeredFromUsage, answeredStorageIds, composerChipText, composerReadout, lastTurnUserId, preferAnswered, rememberAnswered, stampAnswered, usageNamesAnswered, withRememberedAnswers } from './lib/turn-model'
import { applyRoutedModel, beginAutoRoutedTurn, isRetryableTurnComplete, providerErrorText, submitAutoTurn, turnFallbackError, type AutoTurnTrack, type RoutedTurnPlan } from './lib/auto-route-turn'
import { claimSend, modelRefreshApplies, releaseSend, sendBlockedWhileRunning, stillOnProfile } from './lib/send-guard'
import { appendSessionStream, completedText, interruptGenerationForPriority, interruptLeftSessionIdle, isRunningTurnEnd, replayGapResumes, takeSessionStream } from './lib/turn-events'

const MemoSidebar = memo(Sidebar)

const DEMO = new URLSearchParams(location.search).get('demo') === '1'

/** How a turn is worded for the model: caveman from the composer, the voice note from the voice mode. */
type TurnStyle = { caveman: boolean; backgroundTask: boolean; toneCharter: boolean; voice?: { cutShort: boolean } }
/** The hands-free conversation of the desktop app's main process (the demo pretends). */
function voiceConversation() {
  if (DEMO) return { open: async () => true, close: () => {} }
  const bridge = typeof window === 'undefined' ? undefined : window.hermesBot?.dictation
  if (!bridge?.conversation || !bridge.relisten) return undefined
  const conversation = bridge.conversation
  return {
    open: async () => (await conversation('open')) > 0,
    close: () => { void conversation('close').catch(() => {}) },
  }
}

const styledApiText = (prompt: string, mode: ChatMode, style: TurnStyle) => {
  const modeLayer = style.voice
    ? voiceApiText(prompt, modeApiText(prompt, mode), style.voice.cutShort)
    : cavemanApiText(prompt, modeApiText(prompt, mode), style.caveman)
  const result = turnStyleNotes(modeLayer, prompt, { backgroundTask: style.backgroundTask, toneCharter: style.toneCharter })
  if (result === prompt && !modeLayer) return undefined
  return result
}
const DEMO_ROOM = DEMO && new URLSearchParams(location.search).get('room') === '1'
const DEMO_ROOM_CAPABILITIES: RoomCapabilities = {
  protocol_version: 1, driver: true, persistent_process: true, authority_gateway_id: 'demo',
  features: [], methods: ['groups.capabilities', 'groups.list', 'groups.state', 'groups.log', 'groups.create', 'groups.send', 'groups.stop'], max_log_limit: 100,
}
const ROOM_LIST_MS = 10_000
const ROOM_POLL_MS = 2_000
const MAX_OPEN_DOCUMENTS = 8
const NO_SUBAGENTS: SubagentRow[] = []
const NO_AGENT_PROCESSES: AgentProcess[] = []
/** Reads the turns of every bot. Hermes Desktop re-reads its roster every 5 s. */
const LIVE_STATUS_MS = 6_000
/** Subagents and background processes, every profile. They outlast a turn by minutes: no need to read them as often. */
const BACKGROUND_MS = 15_000
/** The open conversation’s processes and children, only while something may still run (Hermes Desktop: 1 to 5 s). */
const CHAT_BACKGROUND_MS = 5_000
const BUSY = new Set(['working', 'thinking', 'waiting'])
/** Tries at opening the chat of a bot just created, before saying Hermes needs a moment (about 9 s in all). */
const NEW_BOT_OPEN_RETRIES = 3
const asText = (value: unknown) => typeof value === 'string' ? value : ''

const demoLanguage = (): DemoLanguage => (i18n.language === 'fr' ? 'fr' : 'en')

// Visual demo: the stores start from fictional datasets, with no network. This runs before the language setting
// is applied to i18n, so the language is read from the settings.
if (DEMO) {
  const demo = demoData(resolveLanguage(getSettings().language))
  useRosterStore.setState({ bots: demo.bots, selected: 'nova', rosterLoaded: true, connected: true, workSummaries: demo.work })
  useChatStore.setState({ messages: demoChat(demo, 'nova'), routines: demo.routines, chatLoading: false })
  useRoomStore.setState({
    rooms: [demo.room.room], capabilities: DEMO_ROOM_CAPABILITIES, support: 'ready', selectedRoomId: DEMO_ROOM ? demo.room.room.room_id : '',
    cache: { [demo.room.room.room_id]: { room: demo.room.room, driver: demo.room.driver, context: demo.room.context, events: demo.room.events, cursor: demo.room.events.length, epoch: 1, loading: false, error: '' } },
  })
}

// Store actions have a stable identity: we take them once, without subscribing.
const { setBots, updateBot, setSelected, setRosterLoaded, setConnected, setReconnecting, applyWork, publishWork, getWorkSeq, setWorkSeq, clearDoneTimer, markDone } = useRosterStore.getState()
const {
  setActiveChat, setChatModel, setMessages, setRoutines, setRoutinesLoading, setChatLoading, setStreaming, setStreamKey, setRunning, setActivity, setUsage,
  getCached, setCached, updateCachedChat, appendCachedMessage, appendCachedNotes, markCachedFailed, stopAllCachedRuns,
  showProfileFromList, enterProfile, applySyncedChat,
} = useChatStore.getState()
const { addPrompt, settlePrompt, removePrompt, clearSessionPrompts, replaceSessionPrompts, addServerRequest, removeServerRequest, setBrowserVaultRequests, removeBrowserVaultRequest } = useRequestsStore.getState()
const { applyEvent: applySubagentEvent, applyList: applySubagentList, setProcesses: setChatProcesses, setAgentProcesses } = useSubagentsStore.getState()
const { setRooms, setCapabilities, setSupport, selectRoom: selectRoomInStore, closeRoom, removeRoom, patchRoom, setRoomLoading, setRoomError, applySnapshot, setPendingSend, setSendFlight } = useRoomStore.getState()

const systemPrefersDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches || false

/** Theme switch with a circular reveal from the button (View Transitions), instant otherwise. */
function revealTheme(dark: boolean, apply: () => void, origin?: { x: number; y: number }) {
  const reduced = getSettings().reduceMotion || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const start = (document as Document & { startViewTransition?: (callback: () => void) => { ready: Promise<void> } }).startViewTransition
  const commit = () => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    flushSync(apply)
  }
  if (!start || reduced) return commit()
  const x = origin?.x ?? window.innerWidth - 40
  const y = origin?.y ?? window.innerHeight - 40
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y))
  start.call(document, commit).ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 560, easing: 'cubic-bezier(.2, .8, .2, 1)', pseudoElement: '::view-transition-new(root)' },
    )
  }).catch(() => { /* transition interrupted: the theme is already applied */ })
}

export default function App() {
  const { t, i18n: { language } } = useTranslation()
  const clientRef = useRef<HermesClient | null>(null)
  if (!clientRef.current) clientRef.current = new HermesClient()
  const client = clientRef.current
  /** Stale-request guard: only the latest re-read of a Bot Chat applies. */
  const chatRequestRef = useRef(0)
  const initializedRef = useRef(false)
  /** Off-screen streaming text, keyed by session id, used when a completion arrives with empty text. */
  const backgroundStreams = useRef(new Map<string, string>())
  /** Profiles with a send between the click and the last await. Checked before any await. */
  const sendsInFlight = useRef(new Set<string>())
  /** In-flight auto-routed turn metadata for routing log (no prompt stored). */
  const autoTurnRef = useRef(new Map<string, AutoTurnTrack>())
  /** Model Hermes switched to mid-turn, per bot, while that turn is still running. */
  const liveAnsweredRef = useRef(new Map<string, AnsweredBy>())
  /** Same switch, kept after the turn so a late stats read cannot put the selected model's numbers back. */
  const usageAnchorRef = useRef(new Map<string, AnsweredBy>())
  /** Bots whose latest turn has not yet reported usage for the model that is answering. */
  const usageHeldRef = useRef(new Set<string>())
  const [liveAnswered, setLiveAnswered] = useState<AnsweredBy | null>(null)
  const [usageAnchor, setUsageAnchor] = useState<AnsweredBy | null>(null)
  const [usageHeld, setUsageHeld] = useState(false)
  /** The open voice mode, read by the gateway event handler. */
  const voiceRef = useRef<{ session: VoiceSession; profile: string } | null>(null)
  /** Latest Stop per session, so a finished stop does not clear a newer one. */
  const stopTickets = useRef(new Map<string, number>())
  /** Latest model-list request. A late answer for another bot is dropped. */
  const modelRequestRef = useRef(0)
  const syncChatRef = useRef<(profile: string, resumed?: boolean) => Promise<void> | void>(() => undefined)
  const submitPromptResumingRef = useRef<((target: ActiveChat, prompt: string, images: { path: string; mime: string }[], options: { queued?: boolean; apiText?: string; submissionId?: string }) => Promise<ActiveChat>) | null>(null)
  /** Kickoff uses the same Auto submit as the composer. Assigned once those helpers exist. */
  const routeKickoffRef = useRef<KickoffTurnSubmit | null>(null)
  const modelOptionsRef = useRef<ModelOption[]>([])
  /** One in-flight audience read per bot, so a late history result cannot classify the next turn. */
  const turnAudience = useRef(new Map<string, number>())
  const memorySummaryRef = useRef('')

  const [auth, setAuth] = useState<'checking' | 'login' | 'ready'>(DEMO ? 'ready' : 'checking')
  const [authError, setAuthError] = useState('')
  // Shared state: roster (bots, selection, connection, summaries), open conversation (+ cache) and pending requests.
  const bots = useRosterStore((state) => state.bots)
  const selected = useRosterStore((state) => state.selected)
  const rosterLoaded = useRosterStore((state) => state.rosterLoaded)
  const connected = useRosterStore((state) => state.connected)
  const reconnecting = useRosterStore((state) => state.reconnecting)
  const workSummaries = useRosterStore((state) => state.workSummaries)
  const rooms = useRoomStore((state) => state.rooms)
  const selectedRoomId = useRoomStore((state) => state.selectedRoomId)
  const roomCapabilities = useRoomStore((state) => state.capabilities)
  const roomSupport = useRoomStore((state) => state.support)
  const roomCache = useRoomStore((state) => state.cache)
  const roomPendingSends = useRoomStore((state) => state.pendingSends)
  const roomSendFlights = useRoomStore((state) => state.sendFlights)
  const activeChat = useChatStore((state) => state.activeChat)
  const chatModel = useChatStore((state) => state.chatModel)
  const messages = useChatStore((state) => state.messages)
  const routines = useChatStore((state) => state.routines)
  const routinesLoading = useChatStore((state) => state.routinesLoading)
  const chatLoading = useChatStore((state) => state.chatLoading)
  const streaming = useChatStore((state) => state.streaming)
  const streamKey = useChatStore((state) => state.streamKey)
  const running = useChatStore((state) => state.running)
  const activity = useChatStore((state) => state.activity)
  const usage = useChatStore((state) => state.usage)
  const chatCache = useChatStore((state) => state.cache)
  const prompts = useRequestsStore((state) => state.prompts)
  const serverRequests = useRequestsStore((state) => state.serverRequests)
  const browserVaultRequests = useRequestsStore((state) => state.browserVaultRequests)
  const subagentRows = useSubagentsStore((state) => state.rows)
  const agentProcessRows = useSubagentsStore((state) => state.agentProcesses)
  const chatProcesses = useSubagentsStore((state) => state.processes)
  const [detailsOpen, setDetailsOpen] = useState(false)
  // A tab the details panel must show when it opens or is already open (the Subagents history).
  const [detailsTabRequest, setDetailsTabRequest] = useState<DetailsTabRequest | null>(null)
  const [mobileOpen, setMobileOpen] = useState(false)
  const settings = useSettings()
  const appConfig = useAppConfig()
  // In the demo too: the installed animations show up there.
  useEffect(() => { void ensureAppConfig() }, [])
  useEffect(() => {
    if (!connected || DEMO) return
    let cancelled = false
    void ensureAppConfig().then((config) => {
      if (!config.sharedMemory?.injectContext) return
      return loadMemorySummary().then((body) => {
        if (!cancelled && body.enabled) memorySummaryRef.current = body.summary
      })
    })
    return () => { cancelled = true }
  }, [connected])
  // Visual demo: the fictional data follows the interface language, also when it changes in the settings.
  useEffect(() => {
    if (!DEMO) return
    const demo = demoData(language === 'fr' ? 'fr' : 'en')
    useRosterStore.setState({ bots: demo.bots, workSummaries: demo.work })
    useChatStore.setState({ messages: demoChat(demo, useRosterStore.getState().selected), routines: demo.routines })
    setRooms([demo.room.room, ...useRoomStore.getState().rooms.filter((room) => room.room_id !== demo.room.room.room_id)])
    if (useRoomStore.getState().selectedRoomId === demo.room.room.room_id) {
      applySnapshot(demo.room.room.room_id, { room: demo.room.room, driver: demo.room.driver, context: demo.room.context, events: demo.room.events, cursor: demo.room.events.length, latestSeq: demo.room.events.length, epoch: 1, reset: true })
    }
  }, [language])
  const localBotRef = useRef<Bot | null>(null)
  const { showUsage } = settings
  // Context compaction: Manual mode guards the open chat against the user's own limit.
  // Auto handles the window itself (bigger model or automatic compaction): no manual limit banner there.
  const autoGuarded = autoRouterEnabled() && autoModeFor(chatModel, settings) !== null
  const guard = useMemo(() => evaluateGuard(autoGuarded ? 'auto' : settings.compactionMode, settings.compactionGauge, usage), [autoGuarded, settings.compactionMode, settings.compactionGauge, usage])
  const guardRef = useRef(guard)
  guardRef.current = guard
  const refreshChatUsage = useCallback((chat: ActiveChat) => {
    if (DEMO) return
    void loadUsage(client, chat).then((next) => {
      if (!next || useChatStore.getState().activeChat?.sessionId !== chat.sessionId) return
      const anchor = usageAnchorRef.current.get(chat.profile)
      if (anchor && !usageNamesAnswered(next, anchor)) return
      setUsage((value) => mergeUsage(value, next))
      if (anchor) {
        usageHeldRef.current.delete(chat.profile)
        if (useChatStore.getState().activeChat?.profile === chat.profile) setUsageHeld(false)
      }
    }).catch(() => { /* keep the last counters */ })
  }, [client])
  const [compacting, setCompacting] = useState(false)
  const compactingRef = useRef(false)
  // Hermes compacts on its own during a turn: its notice shows in the status line until the text resumes.
  const [compactionLabel, setCompactionLabel] = useState('')
  const [compressionValues, setCompressionValues] = useState<Record<string, CompressionValues>>({})
  const [systemDark, setSystemDark] = useState(systemPrefersDark)
  const dark = settings.theme === 'system' ? systemDark : settings.theme === 'dark'
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null)
  const [editBot, setEditBot] = useState<Bot | null>(null)
  const [teamOpen, setTeamOpen] = useState(false)
  const [roomRoutingOpen, setRoomRoutingOpen] = useState(false)
  const [roomRoutingSaving, setRoomRoutingSaving] = useState(false)
  const [focusSignal, setFocusSignal] = useState(0)
  const [notice, setNotice] = useState('')
  const [modelQuery, setModelQuery] = useState<string | null>(null)
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([])
  modelOptionsRef.current = modelOptions
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState('')
  // Providers that cannot serve the open bot (gateway readiness check), kept with the bot they were checked for.
  const [routeIssues, setRouteIssues] = useState<{ profile: string; issues: Record<string, string> }>({ profile: '', issues: {} })
  const [documents, setDocuments] = useState<OpenDocument[]>([])
  const [railTab, setRailTab] = useState(BOT_RAIL_TAB)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [localOpen, setLocalOpen] = useState(false)
  const localOpenRef = useRef(false)
  // Set after their definition below: the reconnection and notification effects call the latest version.
  const reconnectRef = useRef<() => Promise<void>>(async () => undefined)
  const selectBotRef = useRef<(bot: Bot) => void>(() => undefined)
  type NavTarget = { kind: 'bot'; slug: string } | { kind: 'room'; id: string } | { kind: 'local' }
  const navStackRef = useRef<NavTarget[]>([])
  const navIndexRef = useRef(-1)
  const skipNavPushRef = useRef(false)
  const navPushRef = useRef<(target: NavTarget) => void>(() => undefined)
  const shortcutsRef = useRef({
    connected: false,
    roomSupport: 'unsupported' as RoomSupport,
    onNewBot: (): void => undefined,
    onNewRoom: (): void => undefined,
    toggleDetails: (): void => undefined,
    navigateHistory: (_delta: -1 | 1): void => undefined,
  })
  // Mounted on first open, then kept: a reply keeps going while another bot is on screen.
  const [localStarted, setLocalStarted] = useState(false)
  const [localRunning, setLocalRunning] = useState(false)
  const [localModels, setLocalModels] = useState<LocalModels | null>(() => {
    if (!DEMO) return null
    const { model } = demoData(demoLanguage()).local
    return { available: true, models: [model], defaultModel: model }
  })
  // The local chat’s menu opens: installed models read again. Ollama silent: the list stays, and the chat with it.
  const refreshLocalModels = useCallback(() => {
    if (DEMO) return
    void loadLocalModels().then((next) => { if (next.available) setLocalModels(next) })
  }, [])
  const [newBotOpen, setNewBotOpen] = useState(false)
  const [importBotOpen, setImportBotOpen] = useState(false)
  const [newRoomOpen, setNewRoomOpen] = useState(false)
  const [newBotRetry, setNewBotRetry] = useState<{ slug: string; name: string } | null>(null)
  const roomRequestRef = useRef(new Map<string, number>())
  const roomBusyRef = useRef(new Set<string>())
  const roomIndexRequestRef = useRef(0)
  const demoRoomTimersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const selectRoomRef = useRef<(roomId: string) => void>(() => undefined)
  // Bots just created here whose chat has not opened yet, by slug.
  const freshBotsRef = useRef(new Map<string, FreshBot>())

  /** A turn followed live on this socket: its own events say when it ends. */
  const followedLive = (slug: string) => {
    const cached = getCached(slug)?.chat
    return Boolean(cached?.running && cached.socketGeneration === client.generation)
  }

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  }, [dark])

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!query) return
    const update = () => setSystemDark(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    root.dataset.textSize = settings.textSize
    if (settings.reduceMotion) root.dataset.motion = 'reduce'
    else delete root.dataset.motion
  }, [settings.textSize, settings.reduceMotion])

  useEffect(() => {
    if (DEMO) return
    const unsubscribe = client.onEvent((event) => {
      const current = useChatStore.getState().activeChat
      const currentSession = current?.sessionId
      const isCurrent = Boolean(currentSession && event.session_id === currentSession)
      const payload = event.payload || {}
      if (event.type === 'request.cancel') {
        const requestId = asText(payload.id)
        if (requestId) {
          removeServerRequest(requestId)
          removePrompt(`server-${requestId}`)
        }
        return
      }
      // Delegated children: the Subagents panel of the conversation that spawned them.
      if (event.type?.startsWith('subagent.') && event.session_id) {
        applySubagentEvent(event.session_id, event.type, payload)
        return
      }
      // Question or approval from the bot: the turn stays blocked until the user answers (card above the field).
      if ((event.type === 'clarify.request' || event.type === 'approval.request') && event.session_id) {
        const prompt = parsePendingPrompt(event.session_id, payload)
        if (prompt) {
          addPrompt(prompt)
          if (isCurrent && current && voiceRef.current?.profile === current.profile) voiceRef.current.session.prompt(prompt)
          const owner = isCurrent && current ? current.profile : useRosterStore.getState().bots.find((bot) => bot.sessionId === event.session_id)?.slug
          if (owner) {
            clearDoneTimer(owner)
            updateBot(owner, { status: 'waiting' })
          }
        }
        return
      }
      if ((event.type === 'clarify.settled' || event.type === 'approval.settled') && event.session_id) {
        const promptId = asText(payload.prompt_id)
        settlePrompt(event.session_id, promptId)
        if (isCurrent && current && voiceRef.current?.profile === current.profile) voiceRef.current.session.promptSettled(promptId)
        const owner = useRosterStore.getState().bots.find((bot) => isCurrent && current ? bot.slug === current.profile : bot.sessionId === event.session_id)
        // Answer given here or elsewhere: the bot resumes its turn. Reading the turns corrects it if a question remains.
        if (owner?.status === 'waiting') updateBot(owner.slug, { status: 'working' })
        return
      }
      // The fanout dropped this socket's subscription. Resume re-attaches it; the socket itself stays up.
      if (event.type === 'session.replay_gap' && replayGapResumes(event.session_id, currentSession) && current) {
        void syncChatRef.current(current.profile)
        return
      }
      // A cancelled or replaced queued admission is a message.complete that does not end the running turn.
      const turnEnded = event.type !== 'message.complete' || isRunningTurnEnd(event)
      if (turnEnded && event.type === 'message.complete' && event.session_id) {
        clearSessionPrompts(event.session_id)
      }
      const workOwner = isCurrent && current ? current.profile : event.session_id ? useRosterStore.getState().bots.find((bot) => bot.sessionId === event.session_id)?.slug : undefined
      if (workOwner && turnEnded) {
        applyWork(workOwner, event)
        noteTurnEvent(workOwner, event)
      }
      // “Orion messaged Iris”: a live `message_agent` call, or a turn started by another bot’s message.
      const agentNotes = workOwner ? agentChatMessages(
        agentMessagesFromEvent(event.type, payload, workOwner),
        `live-${asText(payload.tool_id) || asText(payload.turn_id) || Date.now()}`,
        new Date().toISOString(),
      ) : []
      if (workOwner && agentNotes.length) {
        if (isCurrent) setMessages((items) => [...items, ...freshNotes(items, agentNotes)])
        appendCachedNotes(workOwner, agentNotes)
      }
      // A bot that is already open and starts a turn in the background goes “working” right away,
      // without waiting for the roster re-read (30 s). The cache is not marked: if the end of the turn
      // got lost, the next re-read would restore the right status instead of freezing it.
      if (event.type === 'message.start' && event.session_id && !isCurrent) {
        const owner = useRosterStore.getState().bots.find((bot) => bot.sessionId === event.session_id)
        if (owner && owner.slug !== useRosterStore.getState().selected) {
          clearDoneTimer(owner.slug)
          if (owner.status !== 'working') updateBot(owner.slug, { status: 'working' })
        }
      }
      if (event.type === 'message.start' && event.session_id) backgroundStreams.current.delete(event.session_id)
      if (!isCurrent && event.session_id && event.type === 'message.delta') {
        appendSessionStream(backgroundStreams.current, event.session_id, typeof payload.text === 'string' ? payload.text : '')
      }
      if (!isCurrent && event.session_id && event.type === 'message.interim') backgroundStreams.current.set(event.session_id, '')
      if (event.type === 'message.complete' && event.session_id && !isCurrent && turnEnded) {
        const owner = useRosterStore.getState().bots.find((bot) => bot.sessionId === event.session_id)
        const finalText = completedText(payload.text, takeSessionStream(backgroundStreams.current, event.session_id))
        const visibleText = withoutSilentMarkers(finalText)
        if (owner && owner.slug !== useRosterStore.getState().selected) {
          const backgroundRows = !visibleText.trim() || isSilentMessage(visibleText) ? [] : expandToolMessage({
            id: `background-${Date.now()}`, role: 'assistant', content: visibleText, createdAt: new Date().toISOString(),
          })
          const backgroundAnswer = [...backgroundRows].reverse().find((row) => !row.progress)?.content
            ?? backgroundRows.at(-1)?.content
            ?? ''
          const meaningful = backgroundRows.length > 0
          const status = typeof payload.status === 'string' ? payload.status : ''
          if (meaningful) {
            for (const row of backgroundRows) appendCachedMessage(owner.slug, row)
          } else if (finalText.trim()) {
            appendCachedMessage(owner.slug, {
              id: `background-${Date.now()}`, role: 'system', content: finalText, createdAt: new Date().toISOString(), technical: true,
            })
          } else if (status === 'interrupted') {
            appendCachedMessage(owner.slug, {
              id: `background-${Date.now()}`, role: 'system', content: i18n.t('app.turnInterrupted'), createdAt: new Date().toISOString(),
            })
          }
          updateCachedChat(owner.slug, { running: false })
          noteTurnSilence(owner.slug, finalText)
          noteTurnReply(owner.slug, backgroundAnswer)
          markDone(owner.slug)
          const finishedAt = new Date().toISOString()
          // While a worker is running, the unread mark waits for the re-read that sees the bot stopped.
          if (meaningful) setBots((items) => items.map((bot) => bot.slug === owner.slug ? {
            ...bot,
            unread: bot.unread + (owner.workerActive ? 0 : 1),
            preview: backgroundAnswer,
            timestamp: finishedAt,
            seenAt: owner.workerActive ? bot.seenAt : finishedAt,
            status: owner.workerActive ? 'working' : 'done',
          } : bot))
        }
      }
      if (!isCurrent || !current) return
      if (event.type === 'session.usage') {
        // The cache read only exists in the frame’s counters, not in its `usage` view.
        const next = parseUsage({ ...payload, ...(payload.usage as object | undefined) })
        const selectedModel = useChatStore.getState().chatModel || current.model || ''
        const announced = answeredFromUsage(payload, selectedModel)
        if (announced) {
          const chosen = preferAnswered(usageAnchorRef.current.get(current.profile), announced)
          liveAnsweredRef.current.set(current.profile, chosen)
          usageAnchorRef.current.set(current.profile, chosen)
          if (useChatStore.getState().activeChat?.profile === current.profile) {
            setLiveAnswered(chosen)
            setUsageAnchor(chosen)
          }
          const userId = autoTurnRef.current.get(current.profile)?.userMessageId ?? lastTurnUserId(useChatStore.getState().messages)
          if (userId) {
            setMessages((items) => stampAnswered(items, userId, chosen))
            useChatStore.getState().patchCachedMessage(current.profile, userId, { answeredBy: chosen })
          }
        }
        const answering = usageAnchorRef.current.get(current.profile)
        const acceptable = !answering || usageNamesAnswered(next, answering)
        if (next && acceptable) setUsage((value) => mergeUsage(value, next))
        if (acceptable) usageHeldRef.current.delete(current.profile)
        else usageHeldRef.current.add(current.profile)
        if (useChatStore.getState().activeChat?.profile === current.profile) setUsageHeld(usageHeldRef.current.has(current.profile))
      }
      if (event.type === 'message.start') {
        // `session.steer` and `session.interrupt` target this turn, not the previous one.
        if (event.execution_generation) setActiveChat({ ...current, executionGeneration: event.execution_generation })
        liveAnsweredRef.current.delete(current.profile)
        usageAnchorRef.current.delete(current.profile)
        usageHeldRef.current.add(current.profile)
        if (useChatStore.getState().activeChat?.profile === current.profile) {
          setLiveAnswered(null)
          setUsageAnchor(null)
          setUsageHeld(true)
        }
        setStreamKey(`turn-${typeof payload.turn_id === 'string' && payload.turn_id ? payload.turn_id : 'tour'}-${Date.now()}`)
        clearDoneTimer(current.profile)
        setRunning(true)
        updateCachedChat(current.profile, { running: true })
        updateBot(current.profile, { status: 'working' })
      }
      if (event.type === 'message.delta') {
        const text = typeof payload.text === 'string' ? payload.text : ''
        if (text && !useChatStore.getState().streamKey) setStreamKey(`turn-tour-${Date.now()}`)
        if (text) setStreaming((value) => value + text)
        setRunning(true)
      }
      // Hermes switched to its own fallback model (rate limit, outage): the chip and the answer follow the real model.
      const hermesFallback = event.type === 'status.update' ? parseModelFallback(payload.text) : null
      if (hermesFallback) {
        const announced = answeredFromEvent('status.update', payload)
        const chosen = announced ? preferAnswered(usageAnchorRef.current.get(current.profile), announced) : null
        const track = autoTurnRef.current.get(current.profile)
        if (track) {
          track.plan.badge = {
            ...track.plan.badge,
            chosen: fallbackRouteId(hermesFallback),
            label: undefined,
            reason: `Hermes fallback${hermesFallback.reason ? ` (${hermesFallback.reason})` : ''} from ${hermesFallback.fromModel}`,
          }
          const badge = track.plan.badge
          useChatStore.getState().patchCachedMessage(current.profile, track.userMessageId, { autoRoute: badge, ...(chosen ? { answeredBy: chosen } : {}) })
          setMessages((items) => items.map((item) => (item.id === track.userMessageId ? { ...item, autoRoute: badge, ...(chosen ? { answeredBy: chosen } : {}) } : item)))
        } else if (chosen) {
          const userId = lastTurnUserId(useChatStore.getState().messages)
          if (userId) {
            setMessages((items) => stampAnswered(items, userId, chosen))
            useChatStore.getState().patchCachedMessage(current.profile, userId, { answeredBy: chosen })
          }
        }
        if (chosen) {
          liveAnsweredRef.current.set(current.profile, chosen)
          usageAnchorRef.current.set(current.profile, chosen)
          usageHeldRef.current.add(current.profile)
          if (useChatStore.getState().activeChat?.profile === current.profile) {
            setLiveAnswered(chosen)
            setUsageAnchor(chosen)
            setUsageHeld(true)
          }
        }
        refreshChatUsage(current)
      }
      // Hermes compacts the context on its own before a turn: say so while it works.
      if (event.type === 'status.update' && (payload.kind === 'compacting' || payload.kind === 'compacted')) {
        if (payload.kind === 'compacting') {
          const tokens = compactingTokens(payload.text)
          const label = tokens ? i18n.t('compaction.activity', { tokens: compactNumber(tokens) }) : i18n.t('compaction.activityBare')
          setCompactionLabel(label)
          setActivity(label)
        } else {
          setCompactionLabel('')
          setActivity('')
        }
      }
      if (event.type === 'message.delta') setCompactionLabel('')
      if (event.type === 'tool.start') {
        setActivity(typeof payload.name === 'string' && payload.name ? toolLabel(payload.name) : i18n.t('app.toolRunning'))
        if (current) {
          const track = autoTurnRef.current.get(current.profile)
          if (track) track.toolsRan = true
        }
      }
      if (event.type === 'tool.complete') setActivity('')
      // A step sealed: the next text starts afresh, so the reply's fallback text is only the reply.
      if (event.type === 'message.interim') {
        const step = typeof payload.text === 'string' ? withoutSilentMarkers(payload.text) : ''
        const parsed = step ? parseToolTranscript(step) : null
        const spoken = parsed?.visible || (parsed?.steps[0] ? transcriptStepLabel(parsed.steps[0]) : step)
        if (spoken && step && !isSilentMessage(step) && voiceRef.current?.profile === current.profile) voiceRef.current.session.turnStep(spoken)
        if (getSettings().progressInThread && step && !isSilentMessage(step)) {
          const segment = typeof payload.segment === 'number' ? payload.segment : Date.now()
          const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : 'turn'
          const lines = parsed && parsed.steps.length
            ? [
                ...(parsed.visible && shouldRecordProgress(parsed.visible) ? [progressBubbleText(parsed.visible)] : []),
                ...parsed.steps.map((item) => transcriptStepLabel(item)),
              ]
            : (shouldRecordProgress(step) ? [progressBubbleText(step)] : [])
          lines.forEach((content, index) => {
            const progress: ChatMessage = {
              id: `progress-${turnId}-${segment}-${index}`,
              role: 'assistant',
              content,
              createdAt: new Date().toISOString(),
              progress: true,
            }
            setMessages((items) => (items.some((item) => item.id === progress.id || (item.progress && item.content === content)) ? items : [...items, progress]))
            appendCachedMessage(current.profile, progress)
          })
        }
        setStreaming('')
        if (current.sessionId) backgroundStreams.current.set(current.sessionId, '')
      }
      if (event.type === 'message.complete' && turnEnded) {
        const status = typeof payload.status === 'string' ? payload.status : 'complete'
        const finalUsage = parseUsage(payload.usage)
        const usageAnchorNow = usageAnchorRef.current.get(current.profile)
        const usageOk = !usageAnchorNow || usageNamesAnswered(finalUsage, usageAnchorNow)
        if (finalUsage && usageOk) setUsage((value) => mergeUsage(value, finalUsage))
        let deferTurnEnd = false
        const autoTrack = autoTurnRef.current.get(current.profile)
        if (autoTrack && current.sessionId) {
          if (status === 'error') {
            const detail = providerErrorText(payload)
            if (detail) autoTrack.quotaErrors = [...(autoTrack.quotaErrors ?? []), quotaErrorHint(autoTrack.plan.badge.chosen, detail)]
          }
          const logAutoRoute = (outcome: 'ok' | 'error' | 'cancelled') => {
            void appendAutoRouteLog({
              mode: autoTrack.plan.mode,
              bot: current.profile,
              sessionId: current.sessionId,
              category: autoTrack.plan.badge.category,
              chosen: autoTrack.plan.badge.chosen,
              reason: autoTrack.plan.badge.reason,
              candidates: autoTrack.plan.decision.candidates ?? [],
              fallbacks: autoTrack.fallbacks,
              tokensIn: finalUsage?.inputTokens ?? null,
              tokensOut: finalUsage?.outputTokens ?? null,
              costUsd: null,
              latencyMs: Date.now() - autoTrack.startedAt,
              outcome,
              triage: autoTrack.plan.decision.triage,
              quotaErrors: autoTrack.quotaErrors ?? [],
            })
            autoTurnRef.current.delete(current.profile)
          }
          const mayFallbackInTurn = status === 'error'
            && isRetryableTurnComplete(payload)
            && !autoTrack.toolsRan
            && !autoTrack.resubmitting
            && autoTrack.fallbacks.length < 2
            && autoTrack.fallbackQueue.length > 0
          if (mayFallbackInTurn && submitPromptResumingRef.current) {
            deferTurnEnd = true
            autoTrack.resubmitting = true
            const next = autoTrack.fallbackQueue.shift()!
            const err = turnFallbackError(payload)
            autoTrack.fallbacks.push({ model: `${next.provider}/${next.model}`, error: err })
            autoTrack.plan.badge = {
              ...autoTrack.plan.badge,
              chosen: `${next.provider}/${next.model}`,
              label: fallbackLabel(autoTrack.plan.decision, next),
              reason: `Fallback after ${err}`,
            }
            useChatStore.getState().patchCachedMessage(current.profile, autoTrack.userMessageId, { autoRoute: autoTrack.plan.badge })
            setMessages((items) => items.map((item) => (item.id === autoTrack.userMessageId ? { ...item, autoRoute: autoTrack.plan.badge } : item)))
            void (async () => {
              try {
                const applied = await applyRoutedModel(client, autoTrack.chat, next)
                autoTrack.chat = applied.chat
                useChatStore.getState().updateCachedChat(current.profile, {
                  model: applied.chat.model,
                  revision: applied.chat.revision,
                  executionGeneration: applied.chat.executionGeneration,
                  running: true,
                })
                setActiveChat({ ...applied.chat, running: true })
                useChatStore.getState().setChatModel((value) => pickerModelAfterRoute(value, applied.chat.model || ''))
                refreshChatUsage(applied.chat)
                await submitPromptResumingRef.current!(autoTrack.chat, autoTrack.prompt, autoTrack.images, { apiText: autoTrack.apiText })
                autoTrack.resubmitting = false
              } catch (error) {
                autoTrack.resubmitting = false
                logAutoRoute('error')
                setRunning(false)
                useChatStore.getState().updateCachedChat(current.profile, { running: false })
                setActivity('')
                setNotice(error instanceof Error ? error.message : i18n.t('app.sendFailed'))
                markDone(current.profile)
              }
            })()
          } else {
            if (status === 'error' && autoTrack.toolsRan && isRetryableTurnComplete(payload)) {
              setNotice(i18n.t('autoRouter.fallbackBlockedTools'))
            }
            logAutoRoute(status === 'error' ? 'error' : status === 'interrupted' ? 'cancelled' : 'ok')
            if (status === 'complete') refreshChatUsage(current)
          }
        }
        if (deferTurnEnd) return
        const buffered = current.sessionId ? takeSessionStream(backgroundStreams.current, current.sessionId) : ''
        const finalText = completedText(payload.text, useChatStore.getState().streaming || buffered)
        const visibleText = withoutSilentMarkers(finalText)
        const answeredNow = liveAnsweredRef.current.get(current.profile) ?? usageAnchorRef.current.get(current.profile)
        const finishedRows = !visibleText.trim() || isSilentMessage(visibleText) ? [] : expandToolMessage({
          id: useChatStore.getState().streamKey || `live-${Date.now()}`,
          role: 'assistant',
          content: visibleText,
          createdAt: new Date().toISOString(),
          failed: status === 'error',
          ...(answeredNow ? { answeredBy: answeredNow } : {}),
        })
        const answerText = [...finishedRows].reverse().find((row) => !row.progress)?.content
          ?? finishedRows.at(-1)?.content
          ?? ''
        const meaningful = finishedRows.length > 0
        if (voiceRef.current?.profile === current.profile) voiceRef.current.session.turnEnded({ text: answerText || visibleText, meaningful })
        if (answeredNow && current.sessionId) {
          const userId = autoTurnRef.current.get(current.profile)?.userMessageId ?? lastTurnUserId(useChatStore.getState().messages)
          rememberAnswered(current.sessionId, answeredStorageIds(payload, userId), answeredNow)
        }
        if (meaningful) {
          const answer = [...finishedRows].reverse().find((row) => !row.progress)
          if (answeredNow && current.sessionId && answer) rememberAnswered(current.sessionId, [answer.id], answeredNow)
          setMessages((items) => [...items, ...finishedRows])
          for (const row of finishedRows) appendCachedMessage(current.profile, row)
          updateCachedChat(current.profile, { running: false })
          // No status here: markDone below sets it. An “idle” in between would hide the end of the turn
          // from the notifications, which only see a working bot become “done”.
          updateBot(current.profile, { preview: answerText, timestamp: finishedRows[0].createdAt })
        }
        if (finalText.trim() && !meaningful) {
          const message: ChatMessage = { id: `silent-${Date.now()}`, role: 'system', content: finalText, createdAt: new Date().toISOString(), technical: true }
          setMessages((items) => [...items, message])
          appendCachedMessage(current.profile, message)
        }
        if (status === 'interrupted' && !finalText.trim()) {
          const message: ChatMessage = { id: `interrupted-${Date.now()}`, role: 'system', content: i18n.t('app.turnInterrupted'), createdAt: new Date().toISOString() }
          setMessages((items) => [...items, message])
          appendCachedMessage(current.profile, message)
        }
        if (usageOk) usageHeldRef.current.delete(current.profile)
        else usageHeldRef.current.add(current.profile)
        if (useChatStore.getState().activeChat?.profile === current.profile) {
          setUsageHeld(usageHeldRef.current.has(current.profile))
        }
        setStreaming('')
        setStreamKey('')
        setRunning(false)
        updateCachedChat(current.profile, { running: false })
        setActivity('')
        setCompactionLabel('')
        noteTurnSilence(current.profile, finalText)
        noteTurnReply(current.profile, answerText)
        markDone(current.profile)
        if (event.execution_generation) setActiveChat({ ...current, executionGeneration: event.execution_generation, running: false })
      }
    })
    const unsubscribeConnection = client.onConnection(setConnected)
    const unsubscribeRequests = client.onServerRequest((request) => {
      const chat = useChatStore.getState().activeChat
      const generation = typeof request.params.execution_generation === 'number' ? request.params.execution_generation : chat?.executionGeneration ?? 0
      const prompt = serverApprovalPrompt(request, generation)
      if (prompt) {
        addPrompt(prompt)
        const sessionId = typeof request.params.session_id === 'string' ? request.params.session_id : ''
        const owner = sessionId ? useRosterStore.getState().bots.find((item) => item.sessionId === sessionId) : undefined
        if (owner) {
          clearDoneTimer(owner.slug)
          updateBot(owner.slug, { status: 'waiting' })
        }
        return
      }
      addServerRequest(request)
    })
    return () => { unsubscribe(); unsubscribeConnection(); unsubscribeRequests(); client.close() }
  }, [client])

  useEffect(() => {
    if (DEMO || auth !== 'ready') return
    // Accounts created without a card (setting in Settings, Vault): a toast, once per notice.
    const showNotices = (notices: BrowserVaultNotice[]) => {
      const fresh = takeUnseenNotices(notices)
      if (!fresh.length) return
      const botName = (slug: string) => useRosterStore.getState().bots.find((bot) => bot.slug === slug)?.name || slug
      const site = (origin: string) => { try { return new URL(origin).host } catch { return origin } }
      setNotice(fresh.map((notice) => i18n.t('browserVault.autoSignupNotice', { bot: botName(notice.bot), site: site(notice.origin), login: notice.identifier })).join(' · '))
    }
    return subscribeBrowserVaultRequests(setBrowserVaultRequests, showNotices)
  }, [auth])

  // Automatic reconnection: a dropped socket, a silent heartbeat, the network or the window coming back.
  useEffect(() => {
    if (DEMO || auth !== 'ready') return
    const reconnector = createReconnector({
      attempt: () => reconnectRef.current(),
      isConnected: () => useRosterStore.getState().connected,
    })
    // Every path that ends disconnected (socket closed, failed attempt, silent heartbeat) goes through the store.
    // A reconnection in progress closes the socket on purpose: only its outcome counts.
    const unsubscribe = useRosterStore.subscribe((state, previous) => {
      if (state.connected || state.reconnecting) return
      if (previous.connected || previous.reconnecting) reconnector.schedule()
    })
    // Back on the window: a hidden-models list saved from the other Mac or the iPhone is read here too.
    const retryNow = () => {
      if (document.hidden) return
      if (useRosterStore.getState().connected) pullSharedSettingsSoon()
      else reconnector.now()
    }
    const onVisible = () => { if (!document.hidden) retryNow() }
    window.addEventListener('online', retryNow)
    window.addEventListener('focus', retryNow)
    document.addEventListener('visibilitychange', onVisible)
    let beating = false
    const heartbeat = setInterval(() => {
      if (beating || document.hidden || !useRosterStore.getState().connected || useRosterStore.getState().reconnecting) return
      beating = true
      const generation = client.generation
      client.request('gateway.ping', {}, HEARTBEAT_TIMEOUT_MS).catch((error: unknown) => {
        // A socket replaced meanwhile is not the one that went silent.
        // A JSON-RPC error result is not a dead socket: only a timeout or a transport error closes it.
        if (client.generation !== generation || !heartbeatFailureClosesSocket(error)) return
        client.close()
        setConnected(false)
      }).finally(() => { beating = false })
    }, HEARTBEAT_MS)
    return () => {
      reconnector.stop()
      unsubscribe()
      clearInterval(heartbeat)
      window.removeEventListener('online', retryNow)
      window.removeEventListener('focus', retryNow)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [auth, client])

  // macOS notifications: a bot is done or waits on an answer, unless its chat is in view.
  useEffect(() => {
    if (DEMO || auth !== 'ready' || typeof Notification === 'undefined') return
    if (getSettings().notifications && Notification.permission === 'default') void Notification.requestPermission()
    const draftKindFromMessages = (slug: string) => {
      const messages = getCached(slug)?.messages || []
      const latest = [...messages].reverse().find((row) => row.role === 'assistant' && !row.technical)
      if (!latest) return null
      const match = new RegExp(`\`\`\`${DRAFT_FENCE}\\n([\\s\\S]*?)\\n\`\`\``).exec(latest.content)
      if (!match || !parseDraftBlock(match[1])) return null
      return 'draft' as const
    }
    const show = (slug: string, kind: NotificationKind) => {
      const viewing = !localOpenRef.current && !useRoomStore.getState().selectedRoomId && useRosterStore.getState().selected === slug
      const bot = useRosterStore.getState().bots.find((item) => item.slug === slug)
      if (!bot || bot.hidden) return
      // A turn between bots, or one that ends in silence, is not for the user. Questions and approvals still are.
      if (kind === 'done' && !turnForUser(slug)) return
      let alertKind = kind
      if (kind === 'done') {
        const draftKind = draftKindFromMessages(slug)
        if (draftKind) alertKind = draftKind
      }
      // The reply recorded when the turn ended first: the cache can still hold the previous turn's message.
      const body = kind === 'done'
        ? notificationBody({
          recorded: recordedReply(slug),
          messages: getCached(slug)?.messages || [],
          fallback: i18n.t('notifications.done'),
        })
        : i18n.t(`notifications.${alertKind}`)
      const enabled = getSettings().notifications
      if (shouldNotify({ enabled, focused: false, viewing })) {
        void enqueuePushRelay({ slug, title: bot.name, body, kind: alertKind })
      }
      if (Notification.permission !== 'granted' || !shouldNotify({ enabled, focused: document.hasFocus() && !document.hidden, viewing })) return
      const notification = new Notification(bot.name, { body, tag: `hermesbot-${slug}` })
      notification.onclick = () => {
        void window.hermesBot?.focusWindow?.()
        window.focus()
        const target = useRosterStore.getState().bots.find((item) => item.slug === slug)
        if (target) selectBotRef.current(target)
        notification.close()
      }
    }
    // message.start carries no prompt text. The user row of this turn is read before a finished-turn
    // notification, and a previous turn's flag is never reused. Questions and approvals do not wait on it.
    const readTurnEnds = async (slug: string) => {
      if (!useRosterStore.getState().connected) return null
      const bot = useRosterStore.getState().bots.find((item) => item.slug === slug)
      const sessionId = bot?.sessionId || getCached(slug)?.chat.sessionId
      if (!sessionId) return null
      const fromHistory = async () => {
        const history = await client.request('session.history', { profile: slug, session_id: sessionId })
        const messages = Array.isArray(history?.messages) ? history.messages : []
        return turnEndsFromRows(messages)
      }
      const fromEvents = async () => {
        const { events } = await loadSessionEvents(client, slug, sessionId, getWorkSeq(slug))
        return turnEndsFromRows(events)
      }
      try {
        const history = await fromHistory()
        if (history.input) return history
        try {
          const events = await fromEvents()
          return { input: events.input, reply: history.reply ?? events.reply }
        } catch {
          return history
        }
      } catch {
        try { return await fromEvents() } catch { return null }
      }
    }
    const notify = (slug: string, kind: NotificationKind) => {
      if (kind !== 'done') {
        show(slug, kind)
        return
      }
      const ticket = (turnAudience.current.get(slug) ?? 0) + 1
      turnAudience.current.set(slug, ticket)
      void readTurnEnds(slug).then((ends) => {
        if (turnAudience.current.get(slug) !== ticket) return
        if (!ends) noteTurnInput(slug, null, null)
        else {
          noteTurnInput(slug, ends.input, ends.reply)
          // Status-only path: the live completion may not have recorded the reply.
          if (ends.reply) noteTurnReply(slug, ends.reply)
        }
        show(slug, 'done')
      })
    }
    const unsubscribeRoster = useRosterStore.subscribe((state, previous) => {
      if (state.bots === previous.bots) return
      const prompts = useRequestsStore.getState().prompts
      const before = new Map(previous.bots.map((bot) => [bot.slug, bot.status]))
      for (const bot of state.bots) {
        let kind = notificationForStatus(before.get(bot.slug), bot.status)
        if (kind === 'question' && bot.status === 'waiting') kind = notificationForWaiting(bot.sessionId, prompts)
        if (kind) notify(bot.slug, kind)
      }
    })
    const unsubscribeRequests = useRequestsStore.subscribe((state, previous) => {
      if (state.serverRequests === previous.serverRequests) return
      const known = new Set(previous.serverRequests.map((request) => request.id))
      for (const request of state.serverRequests) {
        if (known.has(request.id)) continue
        const kind = notificationForRequest(request.method)
        const sessionId = typeof request.params.session_id === 'string' ? request.params.session_id : ''
        const bot = sessionId ? useRosterStore.getState().bots.find((item) => item.sessionId === sessionId) : undefined
        if (kind && bot) notify(bot.slug, kind)
      }
    })
    return () => { unsubscribeRoster(); unsubscribeRequests() }
  }, [auth])

  const routineRunsRef = useRef(new Map<string, string>())
  useEffect(() => {
    if (DEMO || auth !== 'ready') return
    const slug = useRosterStore.getState().selected
    if (!slug) return
    const bot = useRosterStore.getState().bots.find((item) => item.slug === slug)
    if (!bot) return
    for (const routine of routines) {
      const key = `${slug}:${routine.id}`
      const signature = `${routine.lastRunAt || ''}|${routine.lastStatus || ''}`
      const previous = routineRunsRef.current.get(key)
      routineRunsRef.current.set(key, signature)
      if (!previous || previous === signature || !routine.lastRunAt) continue
      const failed = Boolean(routine.lastStatus && routine.lastStatus !== 'ok')
      const body = failed
        ? i18n.t('notifications.routineFailed', { name: routine.name })
        : i18n.t('notifications.routineDone', { name: routine.name })
      if (!getSettings().notifications) continue
      void enqueuePushRelay({ slug, title: bot.name, body, kind: 'routine' })
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') continue
      const notification = new Notification(bot.name, { body, tag: `hermesbot-routine-${routine.id}` })
      notification.onclick = () => {
        void window.hermesBot?.focusWindow?.()
        window.focus()
        notification.close()
      }
    }
  }, [auth, routines])

  useEffect(() => {
    const typingTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false
      return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((value) => !value)
      } else if (event.metaKey && !event.shiftKey && !event.altKey && event.key === ',') {
        event.preventDefault()
        setSettingsTab((tab) => tab ? null : 'general')
      } else if (!typingTarget(event.target) && event.metaKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        shortcutsRef.current.onNewBot()
      } else if (!typingTarget(event.target) && event.metaKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'b') {
        event.preventDefault()
        shortcutsRef.current.toggleDetails()
      } else if (!typingTarget(event.target) && event.metaKey && !event.shiftKey && !event.altKey && event.key === '[') {
        event.preventDefault()
        shortcutsRef.current.navigateHistory(-1)
      } else if (!typingTarget(event.target) && event.metaKey && !event.shiftKey && !event.altKey && event.key === ']') {
        event.preventDefault()
        shortcutsRef.current.navigateHistory(1)
      } else if (event.altKey && !event.metaKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        // The displayed order depends on the sort and the collapsed sections: the roster on screen is authoritative.
        const rows = [...document.querySelectorAll<HTMLElement>('[data-bot], [data-room]')]
        if (!rows.length) return
        event.preventDefault()
        const roomId = useRoomStore.getState().selectedRoomId
        const current = localOpenRef.current ? LOCAL_CHAT_SLUG : useRosterStore.getState().selected
        const at = rows.findIndex((row) => roomId ? row.dataset.room === roomId : row.dataset.bot === current)
        const target = rows[(at + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]
        if (target.dataset.room) {
          selectRoomRef.current(target.dataset.room)
          return
        }
        const bot = target.dataset.bot === LOCAL_CHAT_SLUG ? localBotRef.current : useRosterStore.getState().bots.find((item) => item.slug === target.dataset.bot)
        if (bot) selectBot(bot)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // A file dropped outside the chat must not replace the app with its content.
  useEffect(() => {
    const keepApp = (event: DragEvent) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault() }
    window.addEventListener('dragover', keepApp)
    window.addEventListener('drop', keepApp)
    return () => {
      window.removeEventListener('dragover', keepApp)
      window.removeEventListener('drop', keepApp)
    }
  }, [])

  useEffect(() => {
    if (DEMO || auth !== 'ready') return
    const timer = setInterval(() => {
      if (document.hidden || !useRosterStore.getState().connected) return
      loadRoster(client).then((roster) => {
        setBots((current) => mergeRoster(current, roster.bots, useRosterStore.getState().selected, (slug) => getCached(slug)?.chat.running === true))
      }).catch(() => { /* the connection is reported by the sidebar footer */ })
    }, 30_000)
    return () => clearInterval(timer)
  }, [auth, client])

  // Turns of each bot, profile by profile: a bot woken by another bot goes “Working” within
  // a few seconds, without waiting for the roster re-read or for its chat to be opened. `sessions.changed`
  // brings the next read forward. A hidden window keeps reading while a bot works, and on `sessions.changed`:
  // that is how the end of a turn reaches the notifications while the app is in the background.
  useEffect(() => {
    if (DEMO || auth !== 'ready') return
    let busy = false
    let lastPoll = 0
    const poll = (announced = false) => {
      const bots = useRosterStore.getState().bots
      if (busy || bots.length === 0 || !useRosterStore.getState().connected) return
      if (document.hidden && !announced && !watchWhileHidden(bots)) return
      busy = true
      lastPoll = Date.now()
      loadLiveStatuses(client, useRosterStore.getState().bots.filter((bot) => bot.sessionId).map((bot) => bot.slug)).then(({ statuses, answered }) => {
        for (const bot of useRosterStore.getState().bots) {
          if (!bot.sessionId || !answered.has(bot.slug)) continue
          const live = liveTurnStatus(statuses.get(bot.sessionId))
          const busyNow = bot.status === 'working' || bot.status === 'thinking'
          if (live === 'working' && !busyNow) {
            // A new turn: the previous turn's audience flag must not decide this one.
            forgetTurn(bot.slug)
            clearDoneTimer(bot.slug)
            updateBot(bot.slug, { status: 'working' })
          } else if (live === 'waiting' && bot.status !== 'waiting') {
            clearDoneTimer(bot.slug)
            updateBot(bot.slug, { status: 'waiting' })
          } else if (live === 'idle' && (busyNow || bot.status === 'waiting') && !bot.workerActive && !bot.browserOwner && !followedLive(bot.slug)) {
            markDone(bot.slug)
          }
        }
      }).finally(() => { busy = false })
    }
    const timer = setInterval(() => poll(), LIVE_STATUS_MS)
    const unsubscribe = client.onEvent((event) => {
      if (event.type === 'sessions.changed' && Date.now() - lastPoll > 2_000) poll(true)
    })
    return () => { clearInterval(timer); unsubscribe() }
  }, [auth, client])

  // Standing by: no turn, but subagents or background processes still running. One `subagent.roster` per
  // profile every 15 s, and one for a bot whose turn just ended: that is when work is left running.
  useEffect(() => {
    if (DEMO || auth !== 'ready') return
    let busy = false
    const read = (profiles: string[]) => {
      if (!useRosterStore.getState().connected) return Promise.resolve()
      return loadBackgroundWork(client, profiles).then(({ counts, answered }) => {
        for (const slug of answered) {
          const next = counts.get(slug)
          const bot = useRosterStore.getState().bots.find((item) => item.slug === slug)
          if (bot && !sameBackground(bot.background, next)) updateBot(slug, { background: hasBackground(next) ? next : undefined })
        }
      })
    }
    const poll = () => {
      const profiles = useRosterStore.getState().bots.map((bot) => bot.slug)
      if (busy || document.hidden || profiles.length === 0 || !useRosterStore.getState().connected) return
      busy = true
      read(profiles).finally(() => { busy = false })
    }
    poll()
    const timer = setInterval(poll, BACKGROUND_MS)
    const ended = new Map<string, ReturnType<typeof setTimeout>>()
    const unsubscribe = useRosterStore.subscribe((state, previous) => {
      if (state.bots === previous.bots) return
      const before = new Map(previous.bots.map((bot) => [bot.slug, bot.status]))
      for (const bot of state.bots) {
        if (!BUSY.has(before.get(bot.slug) ?? '') || BUSY.has(bot.status) || ended.has(bot.slug)) continue
        // A short delay: the children and processes the turn left behind are registered by then.
        ended.set(bot.slug, setTimeout(() => { ended.delete(bot.slug); void read([bot.slug]) }, 1_000))
      }
    })
    return () => { clearInterval(timer); unsubscribe(); ended.forEach(clearTimeout) }
  }, [auth, client])

  // The open conversation’s own processes and children (Subagents panel): read when it opens, then every 5 s
  // while a turn, a child or a process may still be running, and right after its turn ends.
  const openSession = activeChat?.sessionId
  const openProfile = activeChat?.profile
  const openSocket = activeChat?.socketGeneration
  useEffect(() => {
    setLiveAnswered(openProfile ? liveAnsweredRef.current.get(openProfile) ?? null : null)
    setUsageAnchor(openProfile ? usageAnchorRef.current.get(openProfile) ?? null : null)
    setUsageHeld(openProfile ? usageHeldRef.current.has(openProfile) : false)
  }, [openProfile])
  useEffect(() => {
    if (DEMO || auth !== 'ready' || !openSession || !openProfile) return
    let stopped = false
    let busy = false
    const chat = { profile: openProfile, sessionId: openSession }
    const refresh = () => {
      if (busy || document.hidden || !useRosterStore.getState().connected) return
      busy = true
      loadChatBackground(client, chat).then(({ processes, agentProcesses, subagents }) => {
        if (stopped) return
        if (processes !== undefined) setChatProcesses(openSession, processes)
        if (agentProcesses) setAgentProcesses(openSession, agentProcesses)
        if (subagents) applySubagentList(openSession, subagents)
      }).finally(() => { busy = false })
    }
    const mayRun = () => {
      const bot = useRosterStore.getState().bots.find((item) => item.slug === openProfile)
      const { rows, processes } = useSubagentsStore.getState()
      return useChatStore.getState().running || hasBackground(bot?.background) || (processes[openSession] ?? 0) > 0 || (rows[openSession] ?? []).some(isSubagentActive)
    }
    refresh()
    const timer = setInterval(() => { if (mayRun()) refresh() }, CHAT_BACKGROUND_MS)
    let turnEnd: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = useChatStore.subscribe((state, previous) => {
      if (previous.running && !state.running && state.activeChat?.sessionId === openSession) {
        clearTimeout(turnEnd)
        turnEnd = setTimeout(refresh, 1_000)
      }
    })
    return () => { stopped = true; clearInterval(timer); clearTimeout(turnEnd); unsubscribe() }
  }, [openSession, openProfile, openSocket, auth, client])

  useEffect(() => {
    if (DEMO) return
    // Events arrive in bursts: the displayed summary refreshes at its own pace, without flickering.
    const timer = setInterval(() => {
      if (document.hidden) return
      publishWork()
    }, 4000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (DEMO || auth !== 'ready') return
    const timer = setInterval(() => {
      if (document.hidden || !useRosterStore.getState().connected) return
      for (const bot of useRosterStore.getState().bots) {
        if ((bot.status !== 'working' && bot.status !== 'thinking') || !bot.sessionId) continue
        // A chat already open on this socket receives its events live.
        if (getCached(bot.slug)?.chat.socketGeneration === client.generation) continue
        loadSessionEvents(client, bot.slug, bot.sessionId, getWorkSeq(bot.slug)).then(({ events, latestSeq }) => {
          setWorkSeq(bot.slug, latestSeq)
          events.forEach((event) => {
            applyWork(bot.slug, event)
            noteTurnEvent(bot.slug, event)
          })
        }).catch(() => { /* session outside this process: the row stays “Working” */ })
      }
    }, 20_000)
    return () => clearInterval(timer)
  }, [auth, client])

  const headerUsageSession = activeChat?.sessionId
  useEffect(() => {
    const chat = useChatStore.getState().activeChat
    if (!(showUsage || settings.compactionMode === 'manual') || !chat || DEMO || chat.sessionId !== headerUsageSession) return
    loadUsage(client, chat).then((next) => {
      if (useChatStore.getState().activeChat?.sessionId === chat.sessionId) setUsage(next)
    }).catch(() => setUsage(null))
  }, [showUsage, settings.compactionMode, selected, chatLoading, client, headerUsageSession])

  // What Hermes does on its own for the open bot (usage readout tooltip): read again when the setting changes.
  useEffect(() => {
    if (DEMO || auth !== 'ready' || !selected) return
    let current = true
    void readCompaction([selected]).then((result) => {
      if (current && result?.profiles[selected]) setCompressionValues((values) => ({ ...values, [selected]: result.profiles[selected] }))
    })
    return () => { current = false }
  }, [auth, selected, settings.compactionMode, settings.compactionGauge])
  const compactionTooltip = settings.compactionMode === 'manual'
    ? (usage?.contextMax ? i18n.t('compaction.yourLimit', { limit: compactNumber(limitTokens(usage.contextMax, settings.compactionGauge)), percent: Math.round(settings.compactionGauge * 100) }) : '')
    : (() => {
        const point = autoCompactionPoint(compressionValues[selected], usage?.contextMax ?? 0)
        return point ? i18n.t('compaction.autoPoint', { point: compactNumber(point) }) : ''
      })()

  const publishDemoRoom = (room: Room, events: RoomEvent[], driver: RoomDriverStatus) => {
    const latestSeq = events.at(-1)?.seq || 0
    applySnapshot(room.room_id, {
      room: { ...room, latest_seq: latestSeq, updated_at: Math.floor(Date.now() / 1000) },
      driver,
      context: useRoomStore.getState().cache[room.room_id]?.context || { purpose: '', notes: '', routing: 'everyone' },
      events,
      cursor: latestSeq,
      latestSeq,
      epoch: room.authority_epoch,
      reset: true,
    })
  }

  const clearDemoRoomTimers = () => {
    demoRoomTimersRef.current.forEach(clearTimeout)
    demoRoomTimersRef.current = []
  }

  /** Reads the room list and the driver's capabilities independently of individual Bot Chats. */
  const refreshRooms = async () => {
    if (DEMO || !useRosterStore.getState().connected) return
    const ticket = ++roomIndexRequestRef.current
    if (useRoomStore.getState().support === 'unknown') setSupport('loading')
    try {
      const capabilities = await loadRoomCapabilities(client)
      if (ticket !== roomIndexRequestRef.current) return
      setCapabilities(capabilities)
      const required = ['groups.list', 'groups.state', 'groups.log', 'groups.create', 'groups.send', 'groups.stop']
      if (!capabilities.driver || required.some((method) => !capabilities.methods.includes(method))) {
        setSupport('unsupported')
        return
      }
      const roomList = await listRooms(client)
      if (ticket !== roomIndexRequestRef.current) return
      setRooms(roomList)
      setSupport('ready')
    } catch (error) {
      if (ticket !== roomIndexRequestRef.current) return
      if (roomMethodMissing(error)) setSupport('unsupported')
      else if (useRoomStore.getState().support !== 'ready') setSupport('error')
    }
  }

  /** Incremental state + log read. A per-room ticket fences late answers after reconnects or authority changes. */
  const refreshRoom = async (roomId: string) => {
    if (DEMO || !roomId || roomBusyRef.current.has(roomId) || !useRosterStore.getState().connected) return
    roomBusyRef.current.add(roomId)
    const ticket = (roomRequestRef.current.get(roomId) || 0) + 1
    roomRequestRef.current.set(roomId, ticket)
    const cached = useRoomStore.getState().cache[roomId]
    if (!cached) setRoomLoading(roomId, true)
    try {
      const snapshot = await readRoom(client, roomId, cached?.cursor || 0, cached?.epoch)
      if (roomRequestRef.current.get(roomId) !== ticket) return
      applySnapshot(roomId, snapshot)
      // The log stopped advancing (an event larger than one page): say so instead of polling it forever.
      if (snapshot.error === ROOM_LOG_STALLED) setRoomError(roomId, i18n.t('room.logStalled'))
    } catch {
      if (roomRequestRef.current.get(roomId) === ticket) setRoomError(roomId, i18n.t('room.loadFailed'))
    } finally {
      roomBusyRef.current.delete(roomId)
    }
  }

  const selectRoom = (roomId: string) => {
    localOpenRef.current = false
    setLocalOpen(false)
    selectRoomInStore(roomId)
    navPushRef.current({ kind: 'room', id: roomId })
    setMobileOpen(false)
    setFocusSignal((value) => value + 1)
    if (!useRoomStore.getState().cache[roomId]) setRoomLoading(roomId, true)
    void refreshRoom(roomId)
  }
  selectRoomRef.current = selectRoom

  useEffect(() => {
    if (DEMO || auth !== 'ready') return
    void refreshRooms()
    const listTimer = setInterval(() => { if (!document.hidden) void refreshRooms() }, ROOM_LIST_MS)
    const roomTimer = setInterval(() => {
      const roomId = useRoomStore.getState().selectedRoomId
      if (roomId && !document.hidden) void refreshRoom(roomId)
    }, ROOM_POLL_MS)
    const unsubscribe = client.onEvent((event) => {
      if (event.type !== 'groups.changed' || !useRosterStore.getState().connected) return
      const ids = Array.isArray(event.payload?.room_ids) ? event.payload.room_ids : []
      const selectedId = useRoomStore.getState().selectedRoomId
      if (selectedId && (!ids.length || ids.includes(selectedId))) void refreshRoom(selectedId)
      void refreshRooms()
    })
    return () => { clearInterval(listTimer); clearInterval(roomTimer); unsubscribe() }
  }, [auth, client])

  useEffect(() => {
    if (!DEMO && auth === 'ready' && selectedRoomId) void refreshRoom(selectedRoomId)
  }, [selectedRoomId, auth, client])

  useEffect(() => () => clearDemoRoomTimers(), [])

  const createNewRoom = async ({ name, bots: selectedBots }: { name: string; bots: Bot[] }) => {
    const issue = validateRoomBots(selectedBots)
    if (issue) throw new Error(i18n.t(issue === 'handles' ? 'newRoom.duplicateHandles' : 'newRoom.invalidCount'))
    if (DEMO) {
      const room = newDemoRoom(name, selectedBots)
      setRooms([room, ...useRoomStore.getState().rooms])
      setNewRoomOpen(false)
      publishDemoRoom(room, [], demoRoomDriver())
      selectRoom(room.room_id)
      return
    }
    const room = await createRoom(client, crypto.randomUUID(), name, selectedBots)
    setRooms([room, ...useRoomStore.getState().rooms.filter((item) => item.room_id !== room.room_id)])
    setNewRoomOpen(false)
    selectRoom(room.room_id)
    setRoomRoutingMode(room.room_id, 'mentions')
    setNotice(i18n.t('room.roomCreated'))
  }

  const roomBots = (room: Room) => room.members.map((member) => useRosterStore.getState().bots.find((bot) => bot.slug === (member.profile || member.member_id))).filter((bot): bot is Bot => Boolean(bot))

  /** Local-only scripted playback. Timers publish the same durable event shapes as the gateway. */
  const runDemoRoom = (room: Room, events: RoomEvent[]) => {
    clearDemoRoomTimers()
    const [user, ...rest] = events
    const settled = rest.at(-1)
    const replies = rest.slice(0, -1)
    if (!user || !settled) return
    const activity = (index: number) => {
      const bot = roomBots(room)[index]
      return bot ? [{ member_id: bot.slug, status: 'running', round_index: index, thread_id: String(user.payload.thread_id || ''), started_at: Math.floor(Date.now() / 1000) }] : []
    }
    publishDemoRoom(room, [user], demoRoomDriver(activity(0)))
    replies.forEach((_reply, index) => {
      demoRoomTimersRef.current.push(setTimeout(() => {
        const visible = [user, ...replies.slice(0, index + 1)]
        publishDemoRoom(room, visible, demoRoomDriver(index + 1 < replies.length ? activity(index + 1) : []))
      }, (index + 1) * 1100))
    })
    demoRoomTimersRef.current.push(setTimeout(() => {
      publishDemoRoom(room, [user, ...replies, settled], demoRoomDriver())
    }, (replies.length + 1) * 1100))
  }

  const replayDemoRoom = () => {
    const room = useRoomStore.getState().cache[useRoomStore.getState().selectedRoomId]?.room
    if (!room) return
    runDemoRoom(room, demoRoomEvents(room, roomBots(room), demoLanguage()))
  }

  const sendOpenRoom = async (content: string): Promise<boolean> => {
    const roomId = useRoomStore.getState().selectedRoomId
    const room = useRoomStore.getState().cache[roomId]?.room
    if (!roomId || !room) return false
    const routing = roomRoutingMode(roomId, useRoomStore.getState().cache[roomId]?.context)
    const members = roomBots(room)
    if (!roomSendAllowed(content.trim(), room.members, members, routing)) {
      setRoomError(roomId, t('roomRouting.mentionRequired'))
      return false
    }
    // Same text as an unconfirmed send: retry with the same event_id. New text: a new event, unless one is in flight.
    const plan = planRoomSend(content, useRoomStore.getState().pendingSends[roomId], Boolean(useRoomStore.getState().sendFlights[roomId]))
    if (plan.status === 'previous-still-sending') {
      setRoomError(roomId, i18n.t('room.previousStillSending'))
      return false
    }
    if (plan.status !== 'send') return false
    const pending = plan.pending
    setPendingSend(roomId, pending)
    setSendFlight(roomId, true)
    setRoomError(roomId, '')
    try {
      if (DEMO) {
        const events = demoRoomEvents(room, roomBots(room), demoLanguage())
        events[0] = { ...events[0], event_id: `demo-user-${pending.eventId}`, payload: { ...events[0].payload, text: content, thread_id: pending.threadId } }
        runDemoRoom(room, events)
      } else {
        await sendRoomMessage(client, roomId, pending.eventId, pending.text, pending.threadId)
        void refreshRoom(roomId)
      }
      setPendingSend(roomId, null)
      return true
    } catch (error) {
      if (roomSendNotAdmitted(error)) {
        setPendingSend(roomId, null)
        setRoomError(roomId, i18n.t('room.notAdmitted'))
      } else {
        // Indeterminate: only a retry with the same event_id can avoid a duplicate room message.
        setRoomError(roomId, i18n.t('room.sendFailed'))
      }
      return false
    } finally {
      setSendFlight(roomId, false)
    }
  }

  const stopOpenRoom = () => stopRoomById(useRoomStore.getState().selectedRoomId)

  const stopRoomById = async (roomId: string) => {
    if (!roomId) return
    if (DEMO) {
      clearDemoRoomTimers()
      const cached = useRoomStore.getState().cache[roomId]
      if (!cached) return
      const seq = cached.cursor + 1
      const stopped: RoomEvent = {
        room_id: roomId, seq, event_id: `demo-stop-${Date.now()}`, kind: 'room.stopped',
        actor: { kind: 'driver', id: 'demo' }, authority_epoch: cached.epoch, payload: {}, created_at: Math.floor(Date.now() / 1000),
      }
      publishDemoRoom(cached.room, [...cached.events, stopped], demoRoomDriver())
      setPendingSend(roomId, null)
      return
    }
    try {
      await stopRoom(client, roomId, roomCancelId(roomId))
      clearRoomCancel(roomId)
      void refreshRoom(roomId)
    } catch {
      setNotice(i18n.t('room.stopFailed'))
    }
  }

  /** Menu rename. The event id is kept while the name stays the same, so a lost reply retries safely. */
  const renameRoomById = async (roomId: string, name: string) => {
    if (DEMO) {
      const room = useRoomStore.getState().rooms.find((item) => item.room_id === roomId)
      if (room) patchRoom({ ...room, name, updated_at: Math.floor(Date.now() / 1000) })
      return
    }
    try {
      const room = await renameRoom(client, roomId, roomRenameEventId(roomId, name), name)
      clearRoomRename(roomId)
      patchRoom(room)
      void refreshRooms()
    } catch (error) {
      throw new Error(i18n.t(`room.menu.errors.${roomActionErrorKey(error)}`))
    }
  }

  /** Menu delete (`groups.disband`). The cancel id is kept until Hermes confirms, so a lost reply retries safely. */
  const deleteRoomById = async (roomId: string) => {
    if (DEMO) {
      clearDemoRoomTimers()
      removeRoom(roomId)
      return
    }
    try {
      await disbandRoom(client, roomId, roomDisbandCancelId(roomId))
    } catch (error) {
      throw new Error(i18n.t(`room.menu.errors.${roomActionErrorKey(error)}`))
    }
    clearRoomDisband(roomId)
    clearRoomCancel(roomId)
    clearRoomRename(roomId)
    // Reads that started before the delete must not bring the room back.
    roomIndexRequestRef.current += 1
    roomRequestRef.current.set(roomId, (roomRequestRef.current.get(roomId) || 0) + 1)
    removeRoom(roomId)
    setNotice(i18n.t('room.menu.deleted'))
    void refreshRooms()
  }

  const initialize = async () => {
    setAuthError('')
    setRosterLoaded(false)
    try {
      const [, appConfig] = await Promise.all([client.connect(), ensureAppConfig()])
      const roster = await loadRoster(client)
      setBots(roster.bots)
      setConnected(true)
      setAuth('ready')
      const defaultBot = appConfig.ui.defaultBot
      const preferred = (defaultBot && roster.bots.find((bot) => bot.slug === defaultBot && !bot.hidden)) || roster.bots.find((bot) => !bot.hidden)
      if (preferred) setSelected((current) => current || preferred.slug)
      void loadLocalModels().then(setLocalModels)
      void syncSharedSettings()
      void refreshRooms()
      if (roster.bots.length === 0) setNotice(i18n.t('app.noVisibleBots'))
    } catch (error) {
      setConnected(false)
      setNotice(error instanceof Error ? error.message : i18n.t('app.connectFailed'))
    } finally {
      setRosterLoaded(true)
    }
  }

  useEffect(() => {
    if (DEMO || initializedRef.current) return
    initializedRef.current = true
    fetch('/api/auth/me', { credentials: 'same-origin' }).then(async (response) => {
      if (response.status === 401) {
        if (await restoreSession() || await localSignIn()) {
          setAuth('ready')
          await initialize()
        } else setAuth('login')
      }
      else if (!response.ok) throw new Error(i18n.t('app.gatewayDown'))
      else {
        setAuth('ready')
        await initialize()
      }
    }).catch((error) => {
      setNotice(error instanceof Error ? error.message : i18n.t('app.gatewayDown'))
      setAuth('login')
    })
  }, [])

  /** Hermes session expired: sign in again with the credentials kept in the Keychain. */
  const restoreSession = async () => {
    const response = await fetch('/api/auth/restore', { method: 'POST', credentials: 'same-origin' })
    if (response.status === 401) {
      const body = await response.json().catch(() => ({}))
      if (body?.error === 'saved_credentials_refused') setNotice(i18n.t('app.savedRefused'))
    }
    return response.ok
  }

  /**
   * A Hermes that needs no password, on this machine: the server opens the session itself, on proof of
   * its local key. The desktop app adds that key to this request; in a browser it comes with the
   * sign-in link the server printed, and leaves the address bar at once.
   */
  const localSignIn = async () => {
    const key = new URLSearchParams(location.search).get('key') || ''
    if (key) history.replaceState(null, '', location.pathname)
    const response = await fetch('/api/auth/local', {
      method: 'POST',
      credentials: 'same-origin',
      headers: key ? { 'X-HermesBot-Local-Key': key } : {},
    }).catch(() => null)
    return response?.ok === true
  }

  const retryLocalSignIn = async () => {
    setAuthError('')
    if (!(await localSignIn())) {
      setAuthError(i18n.t('app.localRefused'))
      return
    }
    setRosterLoaded(false)
    setAuth('ready')
    await reconnect()
  }

  const logout = async () => {
    if (DEMO || !window.confirm(i18n.t('app.confirmLogout'))) return
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => undefined)
    location.reload()
  }

  const login = async (username: string, password: string, remember: boolean) => {
    setAuthError('')
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'basic', username, password, remember }),
    })
    if (!response.ok) {
      setAuthError(response.status === 401 ? i18n.t('app.badCredentials') : i18n.t('app.gatewayRefused'))
      return
    }
    setRosterLoaded(false)
    setAuth('ready')
    await reconnect()
  }

  const reloadOpenRoutines = useCallback(() => {
    const profile = useRosterStore.getState().selected
    if (!profile || DEMO) return
    void loadRoutines(profile).then(async (next) => {
      const list = getAppConfig().routines.eventTriggers ? await enrichRoutines(profile, next) : next
      setRoutines(list)
      const entry = getCached(profile)
      if (entry) setCached(profile, { ...entry, routines: list })
    })
  }, [])

  /** Reloads a Bot Chat. `resumed`: the socket just changed, the server snapshot is authoritative. */
  const syncChat = (profile: string, resumed = false) => {
    const requestId = ++chatRequestRef.current
    const cached = getCached(profile)
    const bot = useRosterStore.getState().bots.find((item) => item.slug === profile)
    // Routines come over the gateway's HTTP side, which can stall while its WebSocket answers:
    // the chat never waits for them. They fill in on their own when they arrive.
    void loadRoutines(profile).then(async (raw) => {
      if (requestId !== chatRequestRef.current) return
      const routines = getAppConfig().routines.eventTriggers ? await enrichRoutines(profile, raw) : raw
      if (requestId !== chatRequestRef.current) return
      setRoutines(routines)
      const entry = getCached(profile)
      if (entry) setCached(profile, { ...entry, routines })
    }, () => {
      if (requestId === chatRequestRef.current && !getCached(profile)?.routines.length) setRoutines([])
    }).finally(() => {
      if (requestId === chatRequestRef.current) setRoutinesLoading(false)
    })
    return openChat(client, profile, cached?.chat.sessionId || bot?.sessionId).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    ).then((chatResult) => {
      if (requestId !== chatRequestRef.current) return
      // After a disconnection, the turn may have ended without us: only the recency test then protects the cache.
      // The cache as it is now: a message sent while the history was loading must not vanish.
      const latest = getCached(profile) || cached
      const preserveLive = !resumed && Boolean(latest && (useChatStore.getState().activeChat?.running || useChatStore.getState().streaming))
      if (chatResult.status === 'fulfilled') {
        const nextMessages = withRememberedAnswers(chatResult.value.chat.sessionId, resolveSyncedMessages(latest, chatResult.value.messages, preserveLive))
        const nextRoutines = getCached(profile)?.routines || cached?.routines || []
        applySyncedChat(profile, { chat: chatResult.value.chat, messages: nextMessages, routines: nextRoutines }, { preserveLive, resumed })
        const openPrompts = chatResult.value.prompts
        replaceSessionPrompts(chatResult.value.chat.sessionId, openPrompts)
        if (chatResult.value.chat.running) updateBot(profile, { status: openPrompts.length ? 'waiting' : 'working' })
        const fresh = freshBotsRef.current.get(profile)
        if (fresh) {
          freshBotsRef.current.delete(profile)
          setNewBotRetry(null)
          const routeKickoff = routeKickoffRef.current
          void kickOffNewBot(client, chatResult.value, fresh, demoLanguage(), (message, error) => markSendFailed(profile, message, error), routeKickoff ?? undefined)
        }
      } else if (!cached && freshBotsRef.current.has(profile)) {
        // A profile Hermes has just created may not be served at once: a few tries, then a way to try again.
        const fresh = freshBotsRef.current.get(profile)!
        if (fresh.attempts < NEW_BOT_OPEN_RETRIES) {
          fresh.attempts += 1
          setTimeout(() => { if (freshBotsRef.current.get(profile) === fresh && useRosterStore.getState().selected === profile) void syncChat(profile) }, 750 * 2 ** fresh.attempts)
          return
        }
        setNewBotRetry({ slug: profile, name: fresh.title })
      } else if (!cached) {
        setNotice(chatResult.reason instanceof Error ? chatResult.reason.message : i18n.t('app.chatOpenFailed'))
      }
      setChatLoading(false)
    })
  }

  /** Starts over with a fresh socket, then resubscribes the open chat: a fresh socket is subscribed to nothing. */
  const reconnect = async () => {
    if (DEMO || useRosterStore.getState().reconnecting) return
    setReconnecting(true)
    setNotice('')
    // Cards answered into a dropped socket are dropped by the gateway. Drop them here; resume puts back what is still open.
    useRequestsStore.getState().clearServerRequests()
    try {
      await window.hermesBot?.restartTunnel()
      const session = await fetch('/api/auth/me', { credentials: 'same-origin' })
      if (session.status === 401 && !(await restoreSession())) {
        client.close()
        setConnected(false)
        setNotice((current) => current || i18n.t('app.sessionExpired'))
        setAuth('login')
        return
      }
      if (session.status !== 401 && !session.ok) throw new Error('gateway_indisponible')
      client.close()
      if (useRosterStore.getState().bots.length === 0) {
        await initialize()
        return
      }
      await client.connect()
      // Turns followed before the disconnection are no longer listened to: the re-read roster says which are still running.
      stopAllCachedRuns()
      const roster = await loadRoster(client)
      setBots((current) => mergeRoster(current, roster.bots, useRosterStore.getState().selected, () => false))
      const reopen = useRosterStore.getState().selected
      if (reopen) await syncChat(reopen, true)
      await refreshRooms()
      const reopenRoom = useRoomStore.getState().selectedRoomId
      if (reopenRoom) await refreshRoom(reopenRoom)
    } catch {
      client.close()
      setConnected(false)
      setNotice(i18n.t('app.noResponse'))
    } finally {
      setReconnecting(false)
      setRosterLoaded(true)
    }
  }

  reconnectRef.current = reconnect
  syncChatRef.current = syncChat

  useEffect(() => {
    if (!selected || DEMO) return
    const profile = selected
    const previous = useChatStore.getState()
    if (previous.activeChat && previous.activeChat.profile !== profile && previous.activeChat.sessionId && previous.streaming) {
      backgroundStreams.current.set(previous.activeChat.sessionId, previous.streaming)
    }
    enterProfile(profile)
    const sessionId = getCached(profile)?.chat.sessionId
    const seeded = sessionId ? backgroundStreams.current.get(sessionId) ?? '' : ''
    if (seeded) {
      setStreaming(seeded)
      if (sessionId) backgroundStreams.current.delete(sessionId)
    }
    setModelQuery(null)
    setMobileOpen(false)
    void syncChat(profile)
  }, [selected, client])

  const pushNav = (target: NavTarget) => {
    if (skipNavPushRef.current) return
    const stack = navStackRef.current
    const cur = stack[navIndexRef.current]
    const sameNav = (a: NavTarget | undefined, b: NavTarget) => {
      if (!a || a.kind !== b.kind) return false
      if (a.kind === 'local') return true
      if (a.kind === 'bot' && b.kind === 'bot') return a.slug === b.slug
      if (a.kind === 'room' && b.kind === 'room') return a.id === b.id
      return false
    }
    if (sameNav(cur, target)) return
    const next = stack.slice(0, navIndexRef.current + 1)
    next.push(target)
    navStackRef.current = next
    navIndexRef.current = next.length - 1
  }
  navPushRef.current = pushNav

  const navigateHistory = (delta: -1 | 1) => {
    const nextIndex = navIndexRef.current + delta
    if (nextIndex < 0 || nextIndex >= navStackRef.current.length) return
    navIndexRef.current = nextIndex
    const target = navStackRef.current[nextIndex]
    skipNavPushRef.current = true
    if (target.kind === 'local') {
      const local = localBotRef.current
      if (local) selectBot(local)
    } else if (target.kind === 'bot') {
      const bot = useRosterStore.getState().bots.find((item) => item.slug === target.slug)
      if (bot) selectBot(bot)
    } else {
      selectRoomRef.current(target.id)
    }
    skipNavPushRef.current = false
  }

  shortcutsRef.current = {
    connected: DEMO || connected,
    roomSupport,
    onNewBot: () => { if (DEMO || connected) setNewBotOpen(true) },
    onNewRoom: () => { if (DEMO || (connected && roomSupport === 'ready')) setNewRoomOpen(true) },
    toggleDetails: () => setDetailsOpen((value) => !value),
    navigateHistory,
  }

  const selectBot = (bot: Bot) => {
    const leaving = useChatStore.getState()
    if (leaving.activeChat && leaving.activeChat.profile !== bot.slug && leaving.activeChat.sessionId && leaving.streaming) {
      backgroundStreams.current.set(leaving.activeChat.sessionId, leaving.streaming)
    }
    closeRoom()
    const wasLocal = localOpenRef.current
    localOpenRef.current = bot.slug === LOCAL_CHAT_SLUG
    setLocalOpen(localOpenRef.current)
    if (localOpenRef.current) {
      setLocalStarted(true)
      setMobileOpen(false)
      setFocusSignal((value) => value + 1)
      pushNav({ kind: 'local' })
      return
    }
    if (wasLocal && useRosterStore.getState().selected === bot.slug) {
      setMobileOpen(false)
      return
    }
    if (useRosterStore.getState().selected === bot.slug) {
      setMobileOpen(false)
      setFocusSignal((value) => value + 1)
      return
    }
    setSelected(bot.slug)
    pushNav({ kind: 'bot', slug: bot.slug })
    // Typing right after the click goes to this bot: the field takes the keyboard as soon as it can.
    setFocusSignal((value) => value + 1)
    if (!DEMO) showProfileFromList(bot.slug)
    updateBot(bot.slug, { unread: 0 })
    if (DEMO) {
      const demo = demoData(demoLanguage())
      setMessages(demoChat(demo, bot.slug))
      setRoutines(demo.routines)
      setChatLoading(false)
      // A bot marked at work shows its turn running: the working line, and the composer's Queue and Priority.
      setRunning(bot.status === 'working')
      setStreaming('')
      setStreamKey('')
      setMobileOpen(false)
    }
  }
  selectBotRef.current = selectBot

  const turnApiText = useCallback((prompt: string, mode: ChatMode, style: TurnStyle) =>
    sharedMemoryApiText(styledApiText(prompt, mode, style), memorySummaryRef.current), [])
  // Without an explicit mode (email card, suggestions), the turn is a normal turn with nothing added,
  // not even the caveman note: an approved email must go out as it was approved.
  /** Fills the picker catalog. Shared by every Auto send, including the new-bot welcome turn. */
  const loadModelsFor = async (profile: string, sessionId: string, shown: () => boolean) => {
    const loaded = await loadModelOptions(client, profile, sessionId)
    modelOptionsRef.current = loaded.options
    if (shown()) setModelOptions(loaded.options)
    return loaded.options
  }
  const noticeAutoStayed = (plan: RoutedTurnPlan, chat: ActiveChat) => {
    const model = chat.model || plan.option.model
    setNotice(i18n.t('autoRouter.stayed', { model: model || i18n.t('autoRouter.currentModel') }))
  }

  /** `voice`: spoken in the voice mode (the voice note replaces caveman). */
  const send = async (text: string, attachments: PendingAttachment[], sentMode?: ChatMode, delivery?: DeliveryMode, voiceOrId?: { cutShort: boolean } | string): Promise<boolean> => {
    // The composer passes its send id as a string. Voice mode passes `{ cutShort }`.
    const voice = typeof voiceOrId === 'object' ? voiceOrId : undefined
    const submissionId = typeof voiceOrId === 'string' ? voiceOrId : undefined
    const mode = sentMode ?? 'exec'
    const prefs = getSettings()
    const caveman = sentMode !== undefined && !voice && prefs.caveman
    const style = {
      caveman,
      backgroundTask: sentMode !== undefined && !voice && prefs.backgroundTask,
      toneCharter: sentMode !== undefined && !voice && prefs.toneCharter,
      voice,
    }
    const now = new Date().toISOString()
    if (DEMO) {
      // During a turn, only a queued or priority message goes in: it waits in the thread, with its label.
      if (running && delivery !== 'queue' && delivery !== 'priority') return false
      if (running) {
        setMessages((items) => [...items, { id: `demo-user-${Date.now()}`, role: 'user', content: text, createdAt: now, delivery: delivery as 'queue' | 'priority' }])
        return true
      }
      setMessages((items) => [...items,
        { id: `demo-user-${Date.now()}`, role: 'user', content: text, createdAt: now },
        { id: `demo-answer-${Date.now()}`, role: 'assistant', content: i18n.t('app.demoAnswer'), createdAt: new Date().toISOString() },
      ])
      return true
    }
    let chat = useChatStore.getState().activeChat
    const profile = chat?.profile
    if (!chat || !profile || !stillOnProfile(useRosterStore.getState().selected, profile)) return false
    // Manual compaction: the user's context limit is reached, compacting comes first. Auto never stops
    // here: it routes to a model the conversation fits in, or compacts before the turn.
    const autoForSend = autoRouterEnabled() && autoModeFor(useChatStore.getState().chatModel, getSettings()) !== null
    if (blocksSending(guardRef.current) && !autoForSend) {
      setNotice(i18n.t('compaction.fullShort'))
      return false
    }
    if (!claimSend(sendsInFlight.current, profile)) return false
    const onScreen = () => stillOnProfile(useRosterStore.getState().selected, profile)
    try {
      // A fresh socket is subscribed to nothing: without resuming, prompt.submit answers permission_denied.
      try {
        await client.connect()
        if (chat.socketGeneration !== client.generation) {
          const reopened = await openChat(client, chat.profile, chat.sessionId)
          chat = reopened.chat
          replaceSessionPrompts(chat.sessionId, reopened.prompts)
          updateCachedChat(profile, chat)
          if (onScreen()) setActiveChat(chat)
        }
      } catch (error) {
        if (onScreen()) setNotice(error instanceof Error ? error.message : i18n.t('app.connectFailed'))
        return false
      }
      const runningNow = onScreen() ? useChatStore.getState().running : getCached(profile)?.chat.running === true
      if (sendBlockedWhileRunning(runningNow, delivery)) return false
      const content = [text, ...attachments.map(attachmentLabel)].join('\n\n')
      clearDoneTimer(profile)
      const userMessage: ChatMessage = { id: `local-${Date.now()}`, role: 'user', content, createdAt: now, ...(runningNow ? { delivery: delivery as 'queue' | 'priority' } : {}) }
      const autoMode = autoRouterEnabled() ? autoModeFor(useChatStore.getState().chatModel, getSettings()) : null
      const autoActive = autoMode !== null
      if (runningNow) {
        if (onScreen()) setMessages((items) => [...items, userMessage])
        appendCachedMessage(profile, userMessage)
        return await queueTurn(chat, text, attachments, userMessage, mode, style, delivery === 'priority', submissionId)
      }
      updateCachedChat(profile, { running: true })
      updateBot(profile, { preview: text, timestamp: now, status: 'working' })
      // The user row has to be in the thread before the first await. Auto routing yields, and a
      // render with `running` but no new user message folds the previous answer into a step.
      // That remounts its card (questions, mail) and the "sent" mark lands on the dead instance.
      if (onScreen()) {
        setRunning(true)
        setActivity('')
        setMessages((items) => [...items, userMessage])
      }
      appendCachedMessage(profile, userMessage)
      const stampAutoBadge = (badge: ChatMessage['autoRoute']) => {
        if (!badge) return
        userMessage.autoRoute = badge
        useChatStore.getState().patchCachedMessage(profile, userMessage.id, { autoRoute: badge })
        if (onScreen()) setMessages((items) => items.map((item) => (item.id === userMessage.id ? { ...item, autoRoute: badge } : item)))
      }
      try {
        let workingChat = chat
        let routedPlan: RoutedTurnPlan | null = null
        const imageCount = attachments.filter((item) => item.kind === 'image').length
        // A conversation left on Auto stays on Auto: only the routed turn uses the concrete model.
        const onModelApplied = (next: ActiveChat) => {
          workingChat = next
          updateCachedChat(profile, { model: next.model, revision: next.revision, executionGeneration: next.executionGeneration })
          if (onScreen()) {
            setActiveChat(next)
            setChatModel((value) => pickerModelAfterRoute(value, next.model || ''))
            refreshChatUsage(next)
          }
        }
        if (autoActive && autoMode) {
          const begun = await beginAutoRoutedTurn({
            client,
            chat: workingChat,
            text,
            imageCount,
            usage,
            modelOptions: modelOptionsRef.current,
            loadModels: () => loadModelsFor(profile, workingChat.sessionId, onScreen),
            analyticsProfiles: useRosterStore.getState().bots.map((bot) => bot.slug),
            mode: autoMode,
            onPlanned: (plan) => stampAutoBadge(plan.badge),
            onModelApplied,
            // Even the largest window cannot hold the conversation with room to work: compact first.
            compactIfNeeded: compactForAuto,
          })
          routedPlan = begun.plan
          workingChat = begun.chat
          stampAutoBadge(routedPlan.badge)
          if (begun.plan.fellBack && onScreen()) noticeAutoStayed(begun.plan, begun.chat)
        }
        const { images, fileRefs } = await uploadAttachments(workingChat, attachments, userMessage, text)
        if (onScreen()) setActivity('')
        const prompt = withMentionNote([text, ...fileRefs].join('\n\n'), useRosterStore.getState().bots, profile)
        const apiText = turnApiText(prompt, mode, style)
        const submitted = await submitAutoTurn({
          client,
          chat: workingChat,
          plan: routedPlan,
          prompt,
          apiText,
          images,
          userMessageId: userMessage.id,
          submit: (target, promptText, promptImages, options) => submitPromptResuming(target, promptText, promptImages, { ...options, submissionId }),
          onModelApplied,
          onBadge: (badge) => {
            useChatStore.getState().patchCachedMessage(profile, userMessage.id, { autoRoute: badge })
            if (onScreen()) setMessages((items) => items.map((item) => (item.id === userMessage.id ? { ...item, autoRoute: badge } : item)))
          },
          remember: (track) => { autoTurnRef.current.set(profile, track) },
        })
        updateCachedChat(profile, { ...submitted, running: true })
        if (onScreen()) {
          const open = useChatStore.getState().activeChat
          if (!open || open.sessionId === submitted.sessionId) setActiveChat({ ...(open ?? submitted), ...submitted, running: true })
        }
        return true
      } catch (error) {
        autoTurnRef.current.delete(profile)
        if (onScreen()) {
          setRunning(false)
          setActivity('')
        }
        updateCachedChat(profile, { running: false })
        updateBot(profile, { status: 'idle' })
        markSendFailed(profile, userMessage, error)
        return false
      }
    } finally {
      releaseSend(sendsInFlight.current, profile)
    }
  }

  /** One resume and one retry when the socket is no longer subscribed to this session. */
  const submitPromptResuming = async (target: ActiveChat, prompt: string, images: { path: string; mime: string }[], options: { queued?: boolean; apiText?: string; submissionId?: string }) => {
    const onScreen = () => stillOnProfile(useRosterStore.getState().selected, target.profile)
    try {
      await submitPrompt(client, target, prompt, images, options)
      return target
    } catch (error) {
      if (!isPermissionDenied(error)) throw error
      const reopened = await openChat(client, target.profile, target.sessionId)
      replaceSessionPrompts(reopened.chat.sessionId, reopened.prompts)
      updateCachedChat(target.profile, reopened.chat)
      if (onScreen()) setActiveChat(reopened.chat)
      await submitPrompt(client, reopened.chat, prompt, images, options)
      return reopened.chat
    }
  }
  submitPromptResumingRef.current = submitPromptResuming

  const markSendFailed = (profile: string, userMessage: ChatMessage, error: unknown) => {
    // An approved email whose delivery to the bot fails must become a card to approve again.
    const onScreen = stillOnProfile(useRosterStore.getState().selected, profile)
    if (onScreen) setMessages((items) => markMessageFailed(items, userMessage.id))
    markCachedFailed(profile, userMessage.id)
    const message: ChatMessage = { id: `error-${Date.now()}`, role: 'system', content: i18n.t('app.notSent'), createdAt: new Date().toISOString() }
    if (onScreen) setMessages((items) => [...items, message])
    appendCachedMessage(profile, message)
    if (onScreen) setNotice(error instanceof Error ? error.message : i18n.t('app.sendFailed'))
  }

  const uploadAttachments = async (chat: ActiveChat, attachments: PendingAttachment[], userMessage?: ChatMessage, text = '') => {
    const images: { path: string; mime: string }[] = []
    const fileRefs: string[] = []
    const onScreen = () => stillOnProfile(useRosterStore.getState().selected, chat.profile)
    for (const attachment of attachments) {
      if (onScreen()) setActivity(i18n.t('app.sending', { name: attachment.name }))
      const dataUrl = await readDataUrl(attachment.file)
      if (attachment.kind === 'image') images.push(await attachImageBytes(client, chat, attachment.name, dataUrl))
      else fileRefs.push(await attachFile(client, chat, attachment.name, dataUrl))
    }
    // The sent images show in the bubble, read back from the gateway like the bot's: no more "[Image: x]".
    const paths = images.map((image) => image.path).filter(Boolean)
    if (userMessage && paths.length) {
      const changes = { content: [text, ...attachments.filter((item) => item.kind !== 'image').map(attachmentLabel)].filter(Boolean).join('\n\n'), images: paths }
      if (onScreen()) setMessages((items) => items.map((item) => item.id === userMessage.id ? { ...item, ...changes } : item))
      useChatStore.getState().patchCachedMessage(chat.profile, userMessage.id, changes)
    }
    return { images, fileRefs }
  }

  /**
   * Message sent during a turn: queued, Hermes starts it when the turn ends. Priority, it goes into
   * the same queue with a resume instruction, then the current turn is interrupted: so it runs right after.
   */
  const queueTurn = async (chat: ActiveChat, text: string, attachments: PendingAttachment[], userMessage: ChatMessage, mode: ChatMode, style: TurnStyle, priority: boolean, submissionId?: string) => {
    const onScreen = () => stillOnProfile(useRosterStore.getState().selected, chat.profile)
    // Copied before submit: a turn that ends during the await must not be interrupted as if it were this message.
    const generation = chat.executionGeneration
    try {
      const { images, fileRefs } = await uploadAttachments(chat, attachments, userMessage, text)
      if (onScreen()) setActivity('')
      const prompt = withMentionNote([text, ...fileRefs].join('\n\n'), useRosterStore.getState().bots, chat.profile)
      const modeText = turnApiText(prompt, mode, style)
      const queuedApiText = priority
        ? priorityApiText(prompt, modeText)
        : (mode !== 'exec' || style.caveman || style.voice || memorySummaryRef.current ? modeText : undefined)
      await submitPromptResuming(chat, prompt, images, { queued: true, apiText: queuedApiText, submissionId })
      if (priority) {
        const open = useChatStore.getState().activeChat
        const after = open?.sessionId === chat.sessionId ? open.executionGeneration : chat.executionGeneration
        const generationToStop = interruptGenerationForPriority(generation, after)
        if (generationToStop !== null) {
          if (onScreen()) setActivity(i18n.t('app.priorityInterrupt'))
          try {
            await interruptChat(client, { ...chat, executionGeneration: generationToStop })
          } catch (error) {
            // stale_generation: the pre-submit turn is already gone. Do not stop the generation that replaced it.
            if (interruptGenerationForPriority(generation, after, error) === null && onScreen()) setActivity('')
          }
        }
      }
      return true
    } catch (error) {
      if (onScreen()) setActivity('')
      markSendFailed(chat.profile, userMessage, error)
      return false
    }
  }

  const openDocument = useCallback((profile: string, media: MediaRef) => {
    const id = `${profile}\n${media.path}`
    setDocuments((items) => items.some((item) => item.id === id)
      ? items.map((item) => item.id === id ? { ...item, revision: item.revision + 1 } : item)
      : [...items, { id, profile, path: media.path, name: media.name, revision: 0 }].slice(-MAX_OPEN_DOCUMENTS))
    setRailTab(id)
    setDetailsOpen(true)
    if (getAppConfig().features.pagesLibrary) {
      touchLibraryPage(profile, media.path, media.name).catch(() => undefined)
    }
  }, [])

  const openLibraryPage = useCallback((page: LibraryPage) => {
    openDocument(page.profile, { path: page.path, name: page.name, kind: 'document' })
  }, [openDocument])

  const onVaultFormDone = useCallback((message: string) => {
    const chat = useChatStore.getState().activeChat
    if (!chat) return
    void send(message, [])
  }, [send])

  /** “History” of the Subagents block: the details panel on its Subagents tab, never opened otherwise. */
  const openSubagentHistory = () => {
    setRailTab(BOT_RAIL_TAB)
    setDetailsTabRequest({ tab: 'subagents', at: Date.now() })
    setDetailsOpen(true)
  }

  const closeDocument = (id: string) => {
    const remaining = documents.filter((item) => item.id !== id)
    setDocuments(remaining)
    setRailTab((current) => current === id ? remaining.at(-1)?.id ?? BOT_RAIL_TAB : current)
  }

  const reloadDocument = (id: string) => {
    setDocuments((items) => items.map((item) => item.id === id ? { ...item, revision: item.revision + 1 } : item))
  }

  const openBot = useCallback((slug: string) => {
    const bot = useRosterStore.getState().bots.find((item) => item.slug === slug)
    if (bot) selectBot(bot)
  }, [])

  /** Three independent reads: a gateway that only knows part of them still shows the rest. */
  const loadUsageDetails = async (): Promise<UsageDetails> => {
    if (DEMO) return demoData(demoLanguage()).usageDetails
    const chat = useChatStore.getState().activeChat
    const [usageResult, contextResult, historyResult] = await Promise.allSettled([
      chat ? loadUsage(client, chat) : Promise.resolve(null),
      chat ? loadContextBreakdown(client, chat) : Promise.resolve(null),
      loadUsageHistory(useRosterStore.getState().selected),
    ])
    return {
      usage: usageResult.status === 'fulfilled' ? usageResult.value : null,
      context: contextResult.status === 'fulfilled' ? contextResult.value : null,
      history: historyResult.status === 'fulfilled' ? historyResult.value : null,
    }
  }

  /** Auto compaction (`session.compress`) when no model can hold the conversation with room to work. */
  const compactForAuto = async (chat: ActiveChat) => {
    if (compactingRef.current || DEMO) return false
    compactingRef.current = true
    setCompacting(true)
    const onChat = () => useChatStore.getState().activeChat?.sessionId === chat.sessionId
    if (onChat()) setActivity(i18n.t('compaction.autoActivity'))
    try {
      const result = parseCompressResult(await client.request('session.compress', { profile: chat.profile, session_id: chat.sessionId }, 300_000))
      if (result.status === 'failed' || result.status === 'aborted') {
        if (onChat()) setNotice(result.message ? i18n.t('compaction.failed', { reason: result.message }) : i18n.t('compaction.failedBare'))
        return false
      }
      if (onChat()) {
        setUsage((value) => {
          const next = mergeUsage(value, result.usage) ?? value
          if (!next) return next
          return { ...next, compressions: result.usage?.compressions ?? (value?.compressions ?? 0) + 1 }
        })
        setNotice(result.before && result.after
          ? i18n.t('compaction.autoDone', { before: compactNumber(result.before), after: compactNumber(result.after) })
          : i18n.t('compaction.doneBare'))
      }
      return true
    } catch (error) {
      if (onChat()) setNotice(error instanceof Error && error.message ? i18n.t('compaction.failed', { reason: error.message }) : i18n.t('compaction.failedBare'))
      return false
    } finally {
      compactingRef.current = false
      setCompacting(false)
      if (onChat()) setActivity('')
    }
  }

  // The new bot's first turn uses the same Auto plan, switch, track and fallback queue as a composer send.
  // Auto off: one plain submit, the kickoff text stays technical either way.
  routeKickoffRef.current = async ({ chat: target, text, apiText, message }) => {
    const profile = target.profile
    const autoMode = autoRouterEnabled() ? autoModeFor(useChatStore.getState().chatModel, getSettings()) : null
    if (!autoMode) {
      await submitPrompt(client, target, text, [], { apiText })
      return target
    }
    const shown = () => stillOnProfile(useRosterStore.getState().selected, profile)
    const onModelApplied = (next: ActiveChat) => {
      const live = { ...next, running: true }
      updateCachedChat(profile, { model: live.model, revision: live.revision, executionGeneration: live.executionGeneration, running: true })
      if (shown()) {
        setActiveChat(live)
        setChatModel((value) => pickerModelAfterRoute(value, live.model || ''))
        refreshChatUsage(live)
      }
    }
    const stamp = (badge: NonNullable<ChatMessage['autoRoute']>) => {
      message.autoRoute = badge
      useChatStore.getState().patchCachedMessage(profile, message.id, { autoRoute: badge })
      if (shown()) setMessages((items) => items.map((item) => item.id === message.id ? { ...item, autoRoute: badge } : item))
    }
    try {
      const begun = await beginAutoRoutedTurn({
        client,
        chat: target,
        text,
        imageCount: 0,
        usage: useChatStore.getState().usage,
        modelOptions: modelOptionsRef.current,
        loadModels: () => loadModelsFor(profile, target.sessionId, shown),
        analyticsProfiles: useRosterStore.getState().bots.map((bot) => bot.slug),
        mode: autoMode,
        onPlanned: (plan) => stamp(plan.badge),
        onModelApplied,
        compactIfNeeded: compactForAuto,
      })
      if (begun.plan.fellBack && shown()) noticeAutoStayed(begun.plan, begun.chat)
      const resume = submitPromptResumingRef.current
      return await submitAutoTurn({
        client,
        chat: begun.chat,
        plan: begun.plan,
        prompt: text,
        apiText,
        images: [],
        userMessageId: message.id,
        submit: (next, prompt, images, options) => resume
          ? resume(next, prompt, images, options)
          : submitPrompt(client, next, prompt, images, options).then(() => next),
        onModelApplied,
        onBadge: stamp,
        remember: (track) => { autoTurnRef.current.set(profile, track) },
      })
    } catch (error) {
      autoTurnRef.current.delete(profile)
      throw error
    }
  }

  // An idle Auto chat near its model's window (80 %): a bigger model takes the next turn, else compact now.
  const autoCompactKeyRef = useRef('')
  useEffect(() => {
    if (DEMO || !activeChat || !autoRouterEnabled()) return
    const autoMode = autoModeFor(chatModel, settings)
    if (!shouldCheckAutoCompact({ autoActive: autoMode !== null, running, compacting, sessionId: activeChat.sessionId, usage, lastKey: autoCompactKeyRef.current })) return
    autoCompactKeyRef.current = autoCompactKey(activeChat.sessionId, usage)
    const chat = activeChat
    void (async () => {
      const decision = await decideAutoRoute({
        bot: chat.profile,
        sessionId: chat.sessionId,
        text: '',
        imageCount: 0,
        contextUsed: usage?.contextUsed,
        contextMax: usage?.contextMax,
        currentModel: chat.model,
        models: modelOptions,
        analyticsProfiles: useRosterStore.getState().bots.map((bot) => bot.slug),
        mode: autoMode ?? 'auto',
      })
      if (!decision.ok || !decision.needsCompaction) return
      if (useChatStore.getState().running || useChatStore.getState().activeChat?.sessionId !== chat.sessionId) return
      await compactForAuto(chat)
    })().catch(() => { /* the next turn routes and checks again */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChat?.sessionId, chatModel, running, compacting, usage?.contextUsed, usage?.contextMax, usage?.compressions])

  /** Manual compaction of the open conversation (`session.compress`): idle session only, about 20 seconds. */
  const compactNow = async () => {
    const chat = useChatStore.getState().activeChat
    if (!chat || compactingRef.current) return
    const bot = useRosterStore.getState().bots.find((item) => item.slug === chat.profile)
    if (useChatStore.getState().running) {
      setNotice(i18n.t('compaction.busy', { name: bot?.name || chat.profile }))
      return
    }
    compactingRef.current = true
    setCompacting(true)
    const stillHere = () => useChatStore.getState().activeChat?.sessionId === chat.sessionId
    try {
      if (DEMO) {
        await new Promise((resolve) => setTimeout(resolve, 900))
        const before = useChatStore.getState().usage
        if (before && stillHere()) setUsage({ ...before, contextUsed: Math.round(before.contextMax * 0.12), contextPercent: 12, compressions: (before.compressions ?? 0) + 1 })
        setNotice(i18n.t('compaction.done', { before: compactNumber(before?.contextUsed ?? 0), after: compactNumber(Math.round((before?.contextMax ?? 0) * 0.12)) }))
        return
      }
      const result = parseCompressResult(await client.request('session.compress', { profile: chat.profile, session_id: chat.sessionId }, 300_000))
      if (result.status === 'failed') {
        setNotice(result.message ? i18n.t('compaction.failed', { reason: result.message }) : i18n.t('compaction.failedBare'))
        return
      }
      if (result.status === 'aborted') {
        setNotice(i18n.t('compaction.aborted'))
        return
      }
      if (stillHere()) {
        setUsage((value) => {
          const next = mergeUsage(value, result.usage) ?? value
          if (!next) return next
          // The count may be missing from the result: one more than before.
          const compressions = result.usage?.compressions ?? (value?.compressions ?? 0) + 1
          return { ...next, compressions }
        })
      }
      setNotice(result.before && result.after
        ? i18n.t('compaction.done', { before: compactNumber(result.before), after: compactNumber(result.after) })
        : i18n.t('compaction.doneBare'))
    } catch (error) {
      if (error instanceof HermesRpcError && error.code === 4009) setNotice(i18n.t('compaction.busy', { name: bot?.name || chat.profile }))
      else setNotice(error instanceof Error && error.message ? i18n.t('compaction.failed', { reason: error.message }) : i18n.t('compaction.failedBare'))
    } finally {
      compactingRef.current = false
      setCompacting(false)
    }
  }

  const stop = async () => {
    const chat = useChatStore.getState().activeChat
    if (!chat || DEMO) {
      setRunning(false)
      if (DEMO) updateBot(useRosterStore.getState().selected, { status: 'idle' })
      return
    }
    const ticket = (stopTickets.current.get(chat.sessionId) ?? 0) + 1
    stopTickets.current.set(chat.sessionId, ticket)
    const sessionId = chat.sessionId
    const latest = () => stopTickets.current.get(sessionId) === ticket && useChatStore.getState().activeChat?.sessionId === sessionId
    try {
      setActivity(i18n.t('app.stopping'))
      const result = await interruptChat(client, chat)
      if (latest() && interruptLeftSessionIdle(result)) {
        setRunning(false)
        updateCachedChat(chat.profile, { running: false })
      }
    } catch (error) {
      if (latest()) setActivity('')
      setNotice(error instanceof Error ? error.message : i18n.t('app.interruptFailed'))
    } finally {
      if (latest()) setActivity('')
    }
  }

  /** New bot dialog, Create: the profile and its card, the bot in the roster, then its chat. Rejects when the profile was not created. */
  const createNewBot = async (draft: BotDraft) => {
    const entry = createdBotEntry(draft)
    if (DEMO) {
      setBots((current) => withCreatedBot(current, entry))
      setNewBotOpen(false)
      selectBot(entry)
      introduceDemoBot(entry.slug, entry.name, demoLanguage())
      return
    }
    const created = await createBot(client, draft)
    try {
      const roster = await loadRoster(client)
      setBots((current) => withCreatedBot(mergeRoster(current, roster.bots, useRosterStore.getState().selected, (slug) => getCached(slug)?.chat.running === true), entry))
    } catch {
      setBots((current) => withCreatedBot(current, entry))
    }
    // No model can serve it yet: no first turn, it would only fail.
    freshBotsRef.current.set(draft.slug, { slug: draft.slug, title: draft.title, kickoff: !created.modelIssue, attempts: 0 })
    setNewBotOpen(false)
    const notes = [
      created.modelIssue ? i18n.t('newBot.needsModel', { name: draft.title, error: created.modelIssue }) : '',
      created.cardError ? i18n.t('newBot.cardFailed', { name: draft.title, reason: botActionError(created.cardError) }) : '',
    ].filter(Boolean)
    if (notes.length) setNotice(notes.join(' '))
    selectBot(useRosterStore.getState().bots.find((bot) => bot.slug === draft.slug) ?? entry)
  }

  // Stable: the dialog reads Hermes' profiles once, when it opens.
  const loadKnownProfiles = useCallback(() => loadProfileNames(client), [client])

  const retryNewBot = (slug: string) => {
    setNewBotRetry(null)
    const fresh = freshBotsRef.current.get(slug)
    if (fresh) fresh.attempts = 0
    const bot = useRosterStore.getState().bots.find((item) => item.slug === slug)
    if (bot && (localOpenRef.current || useRosterStore.getState().selected !== slug)) {
      selectBot(bot)
      return
    }
    setChatLoading(true)
    void syncChat(slug)
  }

  /** Bot menu actions. In the demo nothing goes to Hermes: the roster on screen changes alone. */
  const botAction = (bot: Bot, action: BotAction) => runBotAction(bot, action, {
    client: DEMO ? null : client,
    patchBot: updateBot,
    dropBot: (slug) => {
      const remaining = useRosterStore.getState().bots.filter((item) => item.slug !== slug)
      setBots(remaining)
      // The open bot was deleted: the next visible one opens instead.
      const next = remaining.find((item) => !item.hidden)
      if (useRosterStore.getState().selected === slug && next) {
        if (localOpenRef.current) setSelected(next.slug)
        else selectBot(next)
      }
    },
    refresh: async () => {
      const roster = await loadRoster(client)
      setBots((current) => mergeRoster(current, roster.bots, useRosterStore.getState().selected, (slug) => getCached(slug)?.chat.running === true))
    },
  })

  const chooseTheme = (theme: ThemeChoice, origin?: { x: number; y: number }) => {
    const nextDark = theme === 'system' ? systemDark : theme === 'dark'
    if (nextDark === dark) updateSettings({ theme })
    else revealTheme(nextDark, () => updateSettings({ theme }), origin)
  }

  const openModels = (query: string) => {
    setModelQuery(query)
    refreshModels()
  }

  const refreshModels = () => {
    if (DEMO) return
    const ticket = ++modelRequestRef.current
    const profile = useRosterStore.getState().selected
    setModelsLoading(true)
    setModelsError('')
    const applies = () => modelRefreshApplies(ticket, modelRequestRef.current, profile, useRosterStore.getState().selected)
    loadModelOptions(client, profile, useChatStore.getState().activeChat?.sessionId).then((result) => {
      if (!applies()) return
      setModelOptions(result.options)
      if (result.current) setChatModel((value) => value || defaultAutoPicker() || result.current)
      // The rows appear at once; the routes without a usable key are marked when the checks answer.
      void checkModelRoutes(client, profile, result.options.map((option) => option.provider))
        .then((issues) => { if (applies()) setRouteIssues({ profile, issues }) })
    }).catch((error) => {
      if (applies()) setModelsError(error instanceof Error ? error.message : i18n.t('app.modelsUnavailable'))
    }).finally(() => { if (applies()) setModelsLoading(false) })
  }

  const selectModel = async (option: ModelOption) => {
    const chat = useChatStore.getState().activeChat
    if (!chat) return
    if (isAutoModel(option.model)) {
      setChatModel(option.model)
      setModelQuery(null)
      liveAnsweredRef.current.delete(chat.profile)
      setLiveAnswered(null)
      return
    }
    try {
      // Checked again at the moment of the switch: a route with no usable key would only fail when
      // the next turn builds its agent, after the conversation has already left the working model.
      const issue = await checkModelRoute(client, chat.profile, option.provider)
      if (issue) {
        setRouteIssues((value) => ({ profile: chat.profile, issues: { ...(value.profile === chat.profile ? value.issues : {}), [option.provider]: issue.error } }))
        if (!window.confirm(i18n.t('app.modelRouteUnusable', { provider: option.providerName, error: issue.error }))) return
      }
      // A key is not enough: a provider out of quota still lists the model, and Hermes would only find out
      // on the next turn, then answer with the profile's fallback. A model refused for quota is not offered.
      const probe = await probeModel(option.model)
      if (probe.checked && !probe.ok) {
        if (probe.reason === 'quota') {
          setModelsError(i18n.t('app.modelQuotaRefused', { model: modelLabel(option.model), error: probe.message }))
          return
        }
        if (!window.confirm(i18n.t('app.modelProbeFailed', { model: modelLabel(option.model), error: probe.message }))) return
      }
      let result = await switchModel(client, chat, option)
      if (result?.confirm_required && typeof result.confirm === 'string') {
        if (!window.confirm(result.confirm_message || i18n.t('app.confirmModel', { model: option.model }))) return
        result = await switchModel(client, chat, option, result.confirm)
      }
      const changes: Partial<ActiveChat> = {
        model: option.model,
        ...(typeof result?.revision === 'number' ? { revision: result.revision } : {}),
        ...(typeof result?.execution_generation === 'number' ? { executionGeneration: result.execution_generation } : {}),
      }
      const open = useChatStore.getState().activeChat
      updateCachedChat(chat.profile, changes)
      if (open?.sessionId === chat.sessionId) {
        const synced = { ...open, ...changes }
        setActiveChat(synced)
        setChatModel(option.model)
        setModelQuery(null)
        liveAnsweredRef.current.delete(chat.profile)
        setLiveAnswered(null)
        refreshChatUsage(synced)
        if (result?.deferred) setNotice(i18n.t('app.modelDeferred', { model: modelLabel(option.model) }))
      }
    } catch (error) {
      setModelsError(error instanceof Error ? error.message : i18n.t('app.modelSwitchRefused'))
    }
  }

  const answerServerRequest = (id: string, result: Record<string, unknown>) => {
    const card = useRequestsStore.getState().serverRequests.find((item) => item.id === id)
    try {
      client.respond(id, result)
    } catch (error) {
      if (card && !useRequestsStore.getState().serverRequests.some((item) => item.id === id)) addServerRequest(card)
      setNotice(error instanceof Error ? error.message : i18n.t('app.disconnectedValidate'))
      return
    }
    removeServerRequest(id)
  }

  /**
   * `vault.save_login` answered "I sign in with Google": the protocol only allows declining. The reason
   * goes to the bot first, in its running turn (`session.steer`, delivered right after the tool's result),
   * then the request is declined. Nothing is stored.
   */
  const answerServerRequestSso = async (request: ServerRequest, provider: SsoProvider) => {
    const sessionId = typeof request.params.session_id === 'string' ? request.params.session_id : ''
    const bot = sessionId ? useRosterStore.getState().bots.find((item) => item.sessionId === sessionId) : undefined
    const site = typeof request.params.origin === 'string' && request.params.origin ? request.params.origin : typeof request.params.site === 'string' ? request.params.site : undefined
    const open = useChatStore.getState().activeChat
    const profile = bot?.slug || (open?.sessionId === sessionId ? open.profile : undefined)
    let steered = false
    if (sessionId) {
      try { steered = await steerSession(client, { profile, sessionId }, ssoSteerText(provider, site)) === 'queued' } catch { steered = false }
    }
    answerServerRequest(request.id, { value: '' })
    if (!steered) setNotice(i18n.t('vaultSso.steerFailed', { provider: SSO_NAMES[provider], bot: bot?.name || selectedBot?.name || '' }))
  }

  /** Rejects if the gateway refuses: the card stays open to try again. */
  const answerPendingPrompt = async (prompt: PendingPrompt, answer: string) => {
    const chat = useChatStore.getState().activeChat
    if (!chat || chat.sessionId !== prompt.sessionId) throw new Error('chat_change')
    try {
      if (prompt.serverRequestId) {
        try {
          client.respond(prompt.serverRequestId, { choice: answer })
        } catch (error) {
          setNotice(error instanceof Error ? error.message : i18n.t('app.disconnectedValidate'))
          throw error
        }
        removePrompt(prompt.promptId)
        updateBot(chat.profile, { status: 'working' })
      } else {
        const status = await answerPrompt(client, chat.profile, prompt, answer)
        if (status === 'already_resolved') {
          setNotice(i18n.t('app.alreadyResolved'))
          removePrompt(prompt.promptId)
        }
      }
    } catch (error) {
      if (!prompt.serverRequestId) {
        setNotice(error instanceof Error ? i18n.t('app.answerNotSentWith', { message: error.message }) : i18n.t('app.answerNotSent'))
      }
      throw error
    }
  }

  /** On click in the Subagents panel: the end of a child’s live transcript. */
  const loadOpenSubagentTail = (subagentId: string) => {
    const chat = useChatStore.getState().activeChat
    if (!chat) return Promise.reject(new Error('no_chat'))
    return loadSubagentTail(client, chat, subagentId)
  }

  const answerBrowserVault = async (id: string, body: Record<string, unknown>) => {
    try {
      await respondBrowserVault(id, body)
    } catch (error) {
      // A refused sign-up goes back to the bot and its card closes: the reason stays readable here.
      if (body.action === 'signup') setNotice(i18n.t('browserVault.signupFailed', { reason: error instanceof Error ? error.message : i18n.t('browserVault.errors.default') }))
      throw error
    }
    removeBrowserVaultRequest(id)
  }

  /** A bot's messages for a request card: the open chat when it is that bot, its cache otherwise. */
  const botMessages = (slug?: string, sessionId?: string) => {
    if (activeChat && ((slug && activeChat.profile === slug) || (sessionId && activeChat.sessionId === sessionId))) return messages
    return slug ? getCached(slug)?.messages : undefined
  }

  const rosterSelected = bots.find((bot) => bot.slug === selected) || bots[0]
  const openChatSession = activeChat && activeChat.profile === rosterSelected?.slug ? activeChat.sessionId : undefined
  const openSubagents = (openChatSession && subagentRows[openChatSession]) || NO_SUBAGENTS
  // Every child of the open conversation: the history's calls and results, joined with this window's live rows.
  const openAgentProcesses = (openChatSession && agentProcessRows[openChatSession]) || NO_AGENT_PROCESSES
  const subagentEntries = useMemo(() => subagentHistory(messages, openSubagents, openAgentProcesses), [messages, openSubagents, openAgentProcesses])
  const openProcesses = openChatSession ? chatProcesses[openChatSession] ?? 0 : 0
  // The open conversation’s reads and events are fresher than the roster’s for this bot.
  const openWork = useMemo(() => chatBackground(openSubagents, openProcesses), [openSubagents, openProcesses])
  const selectedBot = useMemo(
    () => rosterSelected && openWork ? { ...rosterSelected, background: mergeBackground(rosterSelected.background, openWork) } : rosterSelected,
    [rosterSelected, openWork],
  )
  const localModel = chooseLocalModel(localModels, settings.localModel)
  // The configured name belongs to the configured model: another model shows its own name.
  const localName = !localModels?.defaultModel || localModel === localModels.defaultModel ? appConfig.localChat.name : ''
  const localBot = useMemo<Bot | null>(
    () => localModel ? { ...localChatBot(localModel, localName), status: localRunning ? 'working' : 'idle' } : null,
    [localModel, localName, localRunning],
  )
  localBotRef.current = localBot
  const shownBots = useMemo(
    () => selectedBot && selectedBot !== rosterSelected ? bots.map((bot) => bot.slug === selectedBot.slug ? selectedBot : bot) : bots,
    [bots, selectedBot, rosterSelected],
  )
  const rosterBots = useMemo(() => !localBot ? shownBots : [...shownBots, localBot], [shownBots, localBot])
  const teamItems = useMemo(
    () => teamFeedFromCaches(Object.fromEntries([...chatCache.entries()].map(([slug, entry]) => [slug, entry.messages])), rosterBots),
    [chatCache, rosterBots],
  )
  const openRequest = serverRequests.find((request) => request.method !== 'approval')
  const shownSession = activeChat?.profile === selectedBot?.slug ? activeChat?.sessionId : selectedBot?.sessionId
  const shownPrompts = shownSession ? prompts.filter((prompt) => prompt.sessionId === shownSession) : []
  const openBrowserVaultRequest = browserVaultRequests[0]
  const openRequestSession = typeof openRequest?.params.session_id === 'string' ? openRequest.params.session_id : undefined
  const openRequestBot = openRequestSession ? bots.find((bot) => bot.sessionId === openRequestSession) : undefined
  const openRequestContext = openRequest && openRequest.method !== 'approval' ? requestContext(botMessages(openRequestBot?.slug, openRequestSession)) : undefined
  const browserVaultContext = openBrowserVaultRequest ? requestContext(botMessages(openBrowserVaultRequest.bot)) : undefined
  const newBotDialog = newBotOpen && (
    <NewBotDialog
      bots={bots}
      connected={DEMO || connected}
      loadKnown={DEMO ? null : loadKnownProfiles}
      onCreate={createNewBot}
      onClose={() => setNewBotOpen(false)}
      onImport={() => { setNewBotOpen(false); setImportBotOpen(true) }}
    />
  )
  const importBotDialog = importBotOpen && (
    <ImportBotDialog
      bots={bots}
      client={DEMO ? null : client}
      connected={DEMO || connected}
      onClose={() => setImportBotOpen(false)}
      onCreated={createNewBot}
    />
  )
  const openRoom = selectedRoomId ? roomCache[selectedRoomId]?.room || rooms.find((room) => room.room_id === selectedRoomId) : null
  const openRoomCache = selectedRoomId ? roomCache[selectedRoomId] : undefined
  const seatable = roomCapabilities?.seatable_profiles
  const roomCandidateBots = bots.filter((bot) => !bot.hidden && (!seatable || seatable.includes(bot.slug)))
  const newRoomDialog = newRoomOpen && <NewRoomDialog bots={roomCandidateBots} connected={DEMO || (connected && roomSupport === 'ready')} onCreate={createNewRoom} onClose={() => setNewRoomOpen(false)} />
  const roomPreviews = useMemo(
    () => Object.fromEntries(rooms.map((room) => [room.room_id, roomPreview(roomCache[room.room_id]?.events || [])])),
    [rooms, roomCache],
  )
  const roomWorking = useMemo(
    () => Object.fromEntries(rooms.map((room) => [room.room_id, Boolean(roomCache[room.room_id]?.driver?.working || roomCache[room.room_id]?.driver?.member_activity?.length)])),
    [rooms, roomCache],
  )
  const sidebarActions = useRef({ reconnect, logout, selectBot, selectRoom, botAction, renameRoomById, deleteRoomById, stopRoomById })
  sidebarActions.current = { reconnect, logout, selectBot, selectRoom, botAction, renameRoomById, deleteRoomById, stopRoomById }
  const onSidebarReconnect = useCallback(() => { void sidebarActions.current.reconnect() }, [])
  const onSidebarLogout = useCallback(() => { void sidebarActions.current.logout() }, [])
  const onSidebarSelect = useCallback((bot: Bot) => { sidebarActions.current.selectBot(bot) }, [])
  const onSidebarSelectRoom = useCallback((roomId: string) => { sidebarActions.current.selectRoom(roomId) }, [])
  const onSidebarRoomRename = useCallback((roomId: string, name: string) => sidebarActions.current.renameRoomById(roomId, name), [])
  const onSidebarRoomDelete = useCallback((roomId: string) => sidebarActions.current.deleteRoomById(roomId), [])
  const onSidebarRoomStop = useCallback((roomId: string) => sidebarActions.current.stopRoomById(roomId), [])
  const onSidebarBotAction = useCallback((bot: Bot, action: BotAction) => sidebarActions.current.botAction(bot, action), [])
  const onSidebarNewBot = useCallback(() => { setNewBotOpen(true); setMobileOpen(false) }, [])
  const onSidebarNewRoom = useCallback(() => { setNewRoomOpen(true); setMobileOpen(false) }, [])
  const onSidebarSettings = useCallback(() => { setSettingsTab('general') }, [])
  const onSidebarEditBot = useCallback((bot: Bot) => { setEditBot(bot); setMobileOpen(false) }, [])
  const onSidebarOpenTeam = useCallback(() => { setTeamOpen(true); setMobileOpen(false) }, [])
  const saveOpenRoomRouting = useCallback(async (mode: RoomRoutingMode, leadId: string) => {
    const roomId = useRoomStore.getState().selectedRoomId
    if (!roomId) return
    setRoomRoutingSaving(true)
    try {
      setRoomRoutingMode(roomId, mode)
      if (!DEMO && mode !== 'mentions') {
        const context = useRoomStore.getState().cache[roomId]?.context
        const patch = gatewayContextPatch(mode, leadId)
        await setRoomContext(client, roomId, crypto.randomUUID(), {
          purpose: context?.purpose || '',
          notes: context?.notes || '',
          routing: patch.routing,
          lead_member_id: patch.lead_member_id,
        })
        await refreshRoom(roomId)
      }
      setNotice(t('roomRouting.saved'))
      setRoomRoutingOpen(false)
    } catch {
      setNotice(t('room.sendFailed'))
    } finally {
      setRoomRoutingSaving(false)
    }
  }, [client, t])
  const onSidebarCloseMobile = useCallback(() => { setMobileOpen(false) }, [])

  // ── Voice mode: one spoken conversation with the open bot ──
  const speechEngine = useMemo(() => createSpeechEngine({ demo: DEMO }), [])
  const [voice, setVoice] = useState<{ session: VoiceSession; profile: string } | null>(null)
  voiceRef.current = voice
  const voiceActions = useRef({ send, answerPendingPrompt })
  voiceActions.current = { send, answerPendingPrompt }
  const closeVoice = useCallback(() => {
    const current = voiceRef.current
    voiceRef.current = null
    current?.session.dispose()
    setVoice(null)
  }, [])
  const openVoice = useCallback(() => {
    const profile = useRosterStore.getState().selected
    if (!speechEngine || voiceRef.current || !profile) return
    const languageCode = () => dictationLanguageCode(getSettings().dictationLanguage, i18n.language)
    const dictation = createDictationEngine({ demo: DEMO, language: languageCode(), languageCode })
    if (!dictation) {
      setNotice(i18n.t('dictation.notice.unavailable'))
      return
    }
    const session: VoiceSession = new VoiceSession({
      dictation,
      speech: speechEngine,
      languageCode,
      settings: () => {
        const current = getSettings()
        return { voices: { fr: current.voiceFr, en: current.voiceEn }, rate: current.voiceRate, speakSteps: current.voiceSteps }
      },
      send: async (text, { cutShort }) => {
        if (!stillOnProfile(useRosterStore.getState().selected, profile)) return false
        const busy = useChatStore.getState().running
        const sent = await voiceActions.current.send(text, [], loadModes()[profile] ?? 'exec', busy ? 'queue' : undefined, { cutShort })
        // The demo answers at once, without gateway events.
        if (sent && DEMO) setTimeout(() => session.turnEnded({ text: i18n.t('app.demoAnswer'), meaningful: true }), 700)
        return sent
      },
      answer: async (prompt, answer) => {
        await voiceActions.current.answerPendingPrompt(prompt, answer)
        return true
      },
      onEnd: closeVoice,
      phrase: (key, language) => i18n.t(`voice.spoken.${key}`, { lng: language }),
      isOffline: () => !navigator.onLine,
      conversation: voiceConversation(),
      initialMode: getSettings().voiceHandsFree ? 'handsfree' : 'push',
    })
    session.setRunning(useChatStore.getState().running)
    const entry = { session, profile }
    voiceRef.current = entry
    setVoice(entry)
    // Same click as the button: hands-free opens its conversation and listens at once.
    session.begin()
  }, [speechEngine, closeVoice])
  // The voice belongs to one bot: another bot, a room, the local chat or a logout ends it.
  useEffect(() => {
    if (voice && (voice.profile !== selected || localOpen || selectedRoomId || auth !== 'ready')) closeVoice()
  }, [voice, selected, localOpen, selectedRoomId, auth, closeVoice])
  useEffect(() => { voice?.session.setRunning(running) }, [voice, running])
  useEffect(() => () => { voiceRef.current?.session.dispose() }, [])

  if (auth === 'checking') {
    return <LoadingScreen />
  }
  if (auth === 'login') return <Login onLogin={login} onLocalSignIn={retryLocalSignIn} error={authError || notice} />
  if (!selectedBot) {
    if (!rosterLoaded) return <LoadingScreen />
    // No bot yet (a fresh Hermes): the first one can be created from here.
    return <div className="app-loading"><p>{t('loading.none')}</p>{notice && <p>{notice}</p>}<button className="connection-retry" disabled={reconnecting} onClick={reconnect}>{reconnecting ? t('loading.reconnecting') : t('loading.reconnect')}</button>{connected && <button className="connection-retry" onClick={() => setNewBotOpen(true)}>{t('sidebar.newBot')}</button>}{newBotDialog}</div>
  }

  return (
    <div className="app-shell">
      <MemoSidebar
        bots={rosterBots}
        rooms={rooms}
        selected={selectedRoomId || (localOpen ? LOCAL_CHAT_SLUG : selectedBot.slug)}
        selectedRoomId={selectedRoomId}
        roomSupport={roomSupport}
        roomPreviews={roomPreviews}
        roomWorking={roomWorking}
        connected={connected}
        reconnecting={reconnecting}
        onReconnect={onSidebarReconnect}
        onLogout={onSidebarLogout}
        workSummaries={workSummaries}
        mobileOpen={mobileOpen}
        onCloseMobile={onSidebarCloseMobile}
        onSelect={onSidebarSelect}
        onSelectRoom={onSidebarSelectRoom}
        canRoomRename={DEMO || roomCanRename(roomCapabilities)}
        canRoomDisband={DEMO || roomCanDisband(roomCapabilities)}
        onRoomRename={onSidebarRoomRename}
        onRoomDelete={onSidebarRoomDelete}
        onRoomStop={onSidebarRoomStop}
        onNewBot={onSidebarNewBot}
        onNewRoom={onSidebarNewRoom}
        onOpenSettings={onSidebarSettings}
        onOpenTeam={onSidebarOpenTeam}
        canManage={DEMO || connected}
        onBotAction={onSidebarBotAction}
        onNotice={setNotice}
        onEditBot={onSidebarEditBot}
      />
      <ChatView
        hidden={localOpen || Boolean(selectedRoomId)}
        bot={selectedBot}
        bots={bots}
        messages={messages}
        streaming={streaming}
        streamKey={streamKey}
        running={running}
        activity={activity}
        workText={workLine(workSummaries[selectedBot.slug], selectedBot.workTitle)}
        loading={chatLoading}
        detailsOpen={detailsOpen}
        focusSignal={focusSignal}
        onOpenMobile={() => setMobileOpen(true)}
        onToggleDetails={() => setDetailsOpen((value) => !value)}
        onSend={send}
        onStop={stop}
        onNotice={setNotice}
        voiceOverlay={voice && voice.profile === selectedBot.slug ? (
          <VoiceOverlay session={voice.session} bot={selectedBot} running={running} activity={activity} onClose={closeVoice} onStopBot={() => void stop()} prompt={shownPrompts[0]} onAnswerPrompt={answerPendingPrompt} handsFreeAvailable={Boolean(voiceConversation())} contextFull={blocksSending(guard)} />
        ) : undefined}
        onVoice={speechEngine ? openVoice : undefined}
        onOpenDocument={openDocument}
        onVaultFormDone={onVaultFormDone}
        onOpenBot={openBot}
        modelLabel={(() => {
          const shown = chatModel || defaultAutoPicker() || ''
          return composerChipText({
            answered: liveAnswered,
            chatModel: shown,
            botModel: selectedBot.model,
            fallbackMark: t('models.fallbackMark'),
            autoLabel: isAutoModel(shown) ? t(shown === AUTO_FREE_MODEL_SENTINEL ? 'models.autoFreeLabel' : 'models.autoLabel') : null,
          })
        })()}
        onOpenModels={openModels}
        usage={composerReadout(usage, { running, fresh: !usageHeld, answered: usageAnchor })}
        showUsage={showUsage}
        onToggleUsage={() => updateSettings({ showUsage: !showUsage })}
        prompts={shownPrompts}
        onAnswerPrompt={answerPendingPrompt}
        subagents={subagentEntries}
        processes={openProcesses}
        onLoadSubagentTail={loadOpenSubagentTail}
        onOpenSubagentHistory={openSubagentHistory}
        compactionLabel={compactionLabel}
        compaction={{
          guard,
          compacting,
          compressions: usage?.compressions,
          onCompact: () => void compactNow(),
          onOpenSettings: () => setSettingsTab('chat'),
          tooltip: compactionTooltip,
        }}
        modelPicker={modelQuery !== null ? (
          <ModelPicker
            options={selectableModels(modelOptions, settings.hiddenModels, [chatModel || defaultAutoPicker() || selectedBot.model, selectedBot.model], settings.freeMode ? appConfig.ui.subscriptionProviders : undefined)}
            autoEnabled={appConfig.autoRouter?.enabled === true}
            freeMode={settings.freeMode}
            current={chatModel || defaultAutoPicker() || selectedBot.model}
            profileModel={selectedBot.model}
            loading={modelsLoading}
            error={modelsError}
            unusable={routeIssues.profile === selected ? routeIssues.issues : undefined}
            initialQuery={modelQuery}
            onSelect={selectModel}
            onClose={() => setModelQuery(null)}
            onManage={() => { setModelQuery(null); setSettingsTab('models') }}
          />
        ) : undefined}
      />
      {openRoom && (
        <RoomView
          key={openRoom.room_id}
          room={openRoom}
          bots={bots}
          events={openRoomCache?.events || []}
          driver={openRoomCache?.driver || null}
          loading={openRoomCache?.loading ?? true}
          error={openRoomCache?.error || ''}
          pending={roomPendingSends[openRoom.room_id] || null}
          sending={Boolean(roomSendFlights[openRoom.room_id])}
          focusSignal={focusSignal}
          onSend={sendOpenRoom}
          onStop={stopOpenRoom}
          onRefresh={() => { setRoomError(openRoom.room_id, ''); void refreshRoom(openRoom.room_id) }}
          onOpenMobile={() => setMobileOpen(true)}
          onOpenBot={openBot}
          onReplay={DEMO ? replayDemoRoom : undefined}
          context={openRoomCache?.context}
          onOpenRouting={() => setRoomRoutingOpen(true)}
        />
      )}
      {roomRoutingOpen && openRoom && (
        <RoomRoutingDialog
          mode={roomRoutingMode(openRoom.room_id, openRoomCache?.context)}
          leadId={openRoomCache?.context?.lead_member_id || openRoom.members[0]?.member_id || ''}
          members={openRoom.members}
          open
          saving={roomRoutingSaving}
          onClose={() => setRoomRoutingOpen(false)}
          onSave={(mode, leadId) => { void saveOpenRoomRouting(mode, leadId) }}
        />
      )}
      {teamOpen && <TeamView items={teamItems} onClose={() => setTeamOpen(false)} onOpenBot={(slug) => { setTeamOpen(false); openBot(slug) }} />}
      {localStarted && localBot && <LocalChatView key={DEMO ? language : undefined} bot={localBot} active={localOpen && !selectedRoomId} focusSignal={focusSignal} onOpenMobile={() => setMobileOpen(true)} onNotice={setNotice} onRunningChange={setLocalRunning} models={localModels} onRefreshModels={refreshLocalModels} demo={DEMO ? demoData(demoLanguage()).local : undefined} />}
      {detailsOpen && !localOpen && !selectedRoomId && (
        <DetailsPanel
          bot={selectedBot}
          work={workSummaries[selectedBot.slug]}
          routines={routines}
          messages={messages}
          subagents={subagentEntries}
          onLoadSubagentTail={loadOpenSubagentTail}
          tabRequest={detailsTabRequest}
          loading={routinesLoading}
          running={running}
          sessionId={activeChat?.sessionId}
          usage={usage}
          loadUsageDetails={loadUsageDetails}
          onOpenDocument={openDocument}
          onOpenLibraryPage={openLibraryPage}
          documents={documents}
          railTab={railTab}
          onSelectRailTab={setRailTab}
          onCloseDocument={closeDocument}
          onReloadDocument={reloadDocument}
          onClose={() => setDetailsOpen(false)}
          client={DEMO ? null : client}
          routinesEditable={appConfig.routines.editable && !DEMO}
          connectorsEnabled={appConfig.connectors.enabled && !DEMO}
          onReloadRoutines={reloadOpenRoutines}
          computerPanelEnabled={appConfig.computerPanel.enabled}
          onComputerSteer={activeChat ? (text) => steerSession(client, { profile: selectedBot.slug, sessionId: activeChat.sessionId }, text).then(() => undefined) : undefined}
        />
      )}
      {openRequest && <ServerRequestDialog key={openRequest.id} request={openRequest} botName={openRequestBot?.name || selectedBot.name} context={openRequestContext} onAnswer={answerServerRequest} onSso={(request, provider) => void answerServerRequestSso(request, provider)} />}
      {openBrowserVaultRequest && <BrowserVaultDialog key={openBrowserVaultRequest.id} request={openBrowserVaultRequest} botName={bots.find((bot) => bot.slug === openBrowserVaultRequest.bot)?.name || openBrowserVaultRequest.bot} context={browserVaultContext} onRespond={answerBrowserVault} />}
      {paletteOpen && <CommandPalette bots={rosterBots} onSelect={(bot) => { setPaletteOpen(false); selectBot(bot) }} onClose={() => setPaletteOpen(false)} />}
      {editBot && (
        <BotEditDialog
          bot={editBot}
          client={DEMO ? null : client}
          onClose={() => setEditBot(null)}
          onSaved={() => setNotice(i18n.t('botEdit.saved'))}
          onNotice={setNotice}
        />
      )}
      {settingsTab && (
        <SettingsDialog
          tab={settingsTab}
          onSelectTab={setSettingsTab}
          onClose={() => setSettingsTab(null)}
          onChooseTheme={chooseTheme}
          localModels={DEMO ? localModels : undefined}
          demo={DEMO}
          models={modelOptions}
          bots={bots}
          compactionContext={usage?.contextMax ? { contextMax: usage.contextMax, modelName: chipModelLabel(chatModel || defaultAutoPicker() || selectedBot.model) } : null}
          modelsLoading={modelsLoading}
          modelsError={modelsError}
          onLoadModels={refreshModels}
          connected={connected}
          reconnecting={reconnecting}
          onReconnect={reconnect}
          onLogout={logout}
          client={DEMO ? null : client}
        />
      )}
      {newBotDialog}
      {importBotDialog}
      {newRoomDialog}
      {newBotRetry && !notice && <NewBotRetry name={newBotRetry.name} onRetry={() => retryNewBot(newBotRetry.slug)} onClose={() => setNewBotRetry(null)} />}
      {notice && <div className="toast" role="status"><AlertCircle size={17} /><span>{notice}</span><button aria-label={t('app.close')} onClick={() => setNotice('')}><X size={15} /></button></div>}
      {DEMO && <div className="demo-badge">{t('app.demoBadge')}</div>}
    </div>
  )
}
