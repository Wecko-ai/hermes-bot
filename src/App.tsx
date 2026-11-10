import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { AlertCircle, X } from 'lucide-react'
import type { Bot, ChatMessage, ModelOption } from './types'
import { answerPrompt, attachFile, attachImageBytes, HermesClient, interruptChat, isSilentMessage, liveTurnStatus, loadContextBreakdown, loadLiveStatuses, loadModelOptions, loadRoster, loadRoutines, loadSessionEvents, loadUsage, loadUsageHistory, mergeUsage, openChat, parsePendingPrompt, parseUsage, submitPrompt, switchModel, type ActiveChat, type PendingPrompt } from './lib/hermes'
import { mergeRoster } from './lib/activity'
import { ensureAppConfig, useAppConfig } from './lib/app-config'
import { workLine } from './lib/work-summary'
import { freshNotes, markMessageFailed, resolveSyncedMessages, useChatStore, useRequestsStore, useRosterStore } from './store'
import { modelLabel } from './lib/model'
import { ModelPicker } from './components/ModelPicker'
import { demoData, type DemoLanguage } from './lib/demo'
import { Sidebar } from './components/Sidebar'
import { ChatView } from './components/ChatView'
import { CommandPalette } from './components/CommandPalette'
import { BOT_RAIL_TAB, DetailsPanel } from './components/DetailsPanel'
import type { OpenDocument } from './components/DocumentView'
import type { UsageDetails } from './components/UsageTab'
import { Login } from './components/Login'
import { LoadingScreen } from './components/LoadingScreen'
import { LocalChatView } from './components/LocalChatView'
import { ServerRequestDialog } from './components/ServerRequestDialog'
import { BrowserVaultDialog } from './components/BrowserVaultDialog'
import { respondBrowserVault, subscribeBrowserVaultRequests } from './lib/browser-vault'
import { attachmentLabel, readDataUrl, type PendingAttachment } from './lib/attachments'
import { withMentionNote } from './lib/mentions'
import { agentChatMessages, agentMessagesFromEvent } from './lib/inter-agent'
import { modeApiText, type ChatMode } from './lib/modes'
import { priorityApiText, type DeliveryMode } from './lib/delivery'
import { LOCAL_CHAT_SLUG, chooseLocalModel, loadLocalModels, localChatBot, type LocalModels } from './lib/local-chat'
import type { MediaRef } from './lib/media'
import { SettingsDialog, type SettingsTab } from './components/SettingsDialog'
import { i18n, resolveLanguage } from './i18n'
import { getSettings, selectableModels, updateSettings, useSettings, type ThemeChoice } from './lib/settings'

const DEMO = new URLSearchParams(location.search).get('demo') === '1'
const MAX_OPEN_DOCUMENTS = 8
/** Reads the turns of every bot. Hermes Desktop re-reads its roster every 5 s. */
const LIVE_STATUS_MS = 6_000
const asText = (value: unknown) => typeof value === 'string' ? value : ''

const demoLanguage = (): DemoLanguage => (i18n.language === 'fr' ? 'fr' : 'en')

// Visual demo: the stores start from fictional datasets, with no network. This runs before the language setting
// is applied to i18n, so the language is read from the settings.
if (DEMO) {
  const demo = demoData(resolveLanguage(getSettings().language))
  useRosterStore.setState({ bots: demo.bots, selected: 'nova', rosterLoaded: true, connected: true, workSummaries: demo.work })
  useChatStore.setState({ messages: demo.messages, routines: demo.routines, chatLoading: false })
}

// Store actions have a stable identity: we take them once, without subscribing.
const { setBots, updateBot, setSelected, setRosterLoaded, setConnected, setReconnecting, applyWork, publishWork, getWorkSeq, setWorkSeq, clearDoneTimer, markDone } = useRosterStore.getState()
const {
  setActiveChat, setChatModel, setMessages, setRoutines, setRoutinesLoading, setChatLoading, setStreaming, setStreamKey, setRunning, setActivity, setUsage,
  getCached, updateCachedChat, appendCachedMessage, appendCachedNotes, markCachedFailed, stopAllCachedRuns,
  showProfileFromList, enterProfile, applySyncedChat,
} = useChatStore.getState()
const { addPrompt, settlePrompt, removePrompt, clearSessionPrompts, replaceSessionPrompts, addServerRequest, removeServerRequest, setBrowserVaultRequests, removeBrowserVaultRequest } = useRequestsStore.getState()

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

  const [auth, setAuth] = useState<'checking' | 'login' | 'ready'>(DEMO ? 'ready' : 'checking')
  const [authError, setAuthError] = useState('')
  // Shared state: roster (bots, selection, connection, summaries), open conversation (+ cache) and pending requests.
  const bots = useRosterStore((state) => state.bots)
  const selected = useRosterStore((state) => state.selected)
  const rosterLoaded = useRosterStore((state) => state.rosterLoaded)
  const connected = useRosterStore((state) => state.connected)
  const reconnecting = useRosterStore((state) => state.reconnecting)
  const workSummaries = useRosterStore((state) => state.workSummaries)
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
  const prompts = useRequestsStore((state) => state.prompts)
  const serverRequests = useRequestsStore((state) => state.serverRequests)
  const browserVaultRequests = useRequestsStore((state) => state.browserVaultRequests)
  const [detailsOpen, setDetailsOpen] = useState(() => window.innerWidth >= 1180)
  const [mobileOpen, setMobileOpen] = useState(false)
  const settings = useSettings()
  const appConfig = useAppConfig()
  // In the demo too: the installed animations show up there.
  useEffect(() => { void ensureAppConfig() }, [])
  // Visual demo: the fictional data follows the interface language, also when it changes in the settings.
  useEffect(() => {
    if (!DEMO) return
    const demo = demoData(language === 'fr' ? 'fr' : 'en')
    useRosterStore.setState({ bots: demo.bots, workSummaries: demo.work })
    useChatStore.setState({ messages: demo.messages, routines: demo.routines })
  }, [language])
  const localBotRef = useRef<Bot | null>(null)
  const { showUsage } = settings
  const [systemDark, setSystemDark] = useState(systemPrefersDark)
  const dark = settings.theme === 'system' ? systemDark : settings.theme === 'dark'
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null)
  const [focusSignal, setFocusSignal] = useState(0)
  const [notice, setNotice] = useState('')
  const [modelQuery, setModelQuery] = useState<string | null>(null)
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState('')
  const [documents, setDocuments] = useState<OpenDocument[]>([])
  const [railTab, setRailTab] = useState(BOT_RAIL_TAB)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [localOpen, setLocalOpen] = useState(false)
  const localOpenRef = useRef(false)
  // Mounted on first open, then kept: a reply keeps going while another bot is on screen.
  const [localStarted, setLocalStarted] = useState(false)
  const [localRunning, setLocalRunning] = useState(false)
  const [localModels, setLocalModels] = useState<LocalModels | null>(null)

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
        removeServerRequest(payload.id as string)
        return
      }
      // Question or approval from the bot: the turn stays blocked until the user answers (card above the field).
      if ((event.type === 'clarify.request' || event.type === 'approval.request') && event.session_id) {
        const prompt = parsePendingPrompt(event.session_id, payload)
        if (prompt) {
          addPrompt(prompt)
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
        const owner = useRosterStore.getState().bots.find((bot) => isCurrent && current ? bot.slug === current.profile : bot.sessionId === event.session_id)
        // Answer given here or elsewhere: the bot resumes its turn. Reading the turns corrects it if a question remains.
        if (owner?.status === 'waiting') updateBot(owner.slug, { status: 'working' })
        return
      }
      // A finished turn waits for nothing.
      if (event.type === 'message.complete' && event.session_id) {
        clearSessionPrompts(event.session_id)
      }
      const workOwner = isCurrent && current ? current.profile : event.session_id ? useRosterStore.getState().bots.find((bot) => bot.sessionId === event.session_id)?.slug : undefined
      if (workOwner) applyWork(workOwner, event)
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
      if (event.type === 'message.complete' && event.session_id && !isCurrent) {
        const owner = useRosterStore.getState().bots.find((bot) => bot.sessionId === event.session_id)
        const finalText = typeof payload.text === 'string' ? payload.text : ''
        if (owner && owner.slug !== useRosterStore.getState().selected) {
          const meaningful = finalText.trim() && !isSilentMessage(finalText)
          appendCachedMessage(owner.slug, {
            id: `background-${Date.now()}`, role: meaningful ? 'assistant' : 'system', content: finalText || '[NO_REPLY]', createdAt: new Date().toISOString(), technical: !meaningful,
          })
          updateCachedChat(owner.slug, { running: false })
          markDone(owner.slug)
          const finishedAt = new Date().toISOString()
          // While a worker is running, the unread mark waits for the re-read that sees the bot stopped.
          if (meaningful) setBots((items) => items.map((bot) => bot.slug === owner.slug ? {
            ...bot,
            unread: bot.unread + (owner.workerActive ? 0 : 1),
            preview: finalText,
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
        if (next) setUsage((value) => mergeUsage(value, next))
      }
      if (event.type === 'message.start') {
        // `session.steer` and `session.interrupt` target this turn, not the previous one.
        if (event.execution_generation) setActiveChat({ ...current, executionGeneration: event.execution_generation })
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
      if (event.type === 'tool.start') {
        setActivity(typeof payload.name === 'string' ? payload.name.replaceAll('_', ' ') : i18n.t('app.toolRunning'))
      }
      if (event.type === 'tool.complete') setActivity('')
      if (event.type === 'message.complete') {
        const status = typeof payload.status === 'string' ? payload.status : 'complete'
        const finalUsage = parseUsage(payload.usage)
        if (finalUsage) setUsage((value) => mergeUsage(value, finalUsage))
        const finalText = typeof payload.text === 'string' && payload.text.trim() ? payload.text : useChatStore.getState().streaming
        if (finalText.trim() && !isSilentMessage(finalText)) {
          const message: ChatMessage = {
            id: useChatStore.getState().streamKey || `live-${Date.now()}`,
            role: 'assistant',
            content: finalText,
            createdAt: new Date().toISOString(),
            failed: status === 'error',
          }
          setMessages((items) => [...items, message])
          appendCachedMessage(current.profile, message)
          updateCachedChat(current.profile, { running: false })
          updateBot(current.profile, { preview: finalText, timestamp: message.createdAt, status: 'idle' })
        }
        if (isSilentMessage(finalText)) {
          const message: ChatMessage = { id: `silent-${Date.now()}`, role: 'system', content: finalText, createdAt: new Date().toISOString(), technical: true }
          setMessages((items) => [...items, message])
          appendCachedMessage(current.profile, message)
        }
        if (status === 'interrupted' && !finalText.trim()) {
          const message: ChatMessage = { id: `interrupted-${Date.now()}`, role: 'system', content: i18n.t('app.turnInterrupted'), createdAt: new Date().toISOString() }
          setMessages((items) => [...items, message])
          appendCachedMessage(current.profile, message)
        }
        setStreaming('')
        setStreamKey('')
        setRunning(false)
        updateCachedChat(current.profile, { running: false })
        setActivity('')
        markDone(current.profile)
        if (event.execution_generation) setActiveChat({ ...current, executionGeneration: event.execution_generation, running: false })
      }
    })
    const unsubscribeConnection = client.onConnection(setConnected)
    const unsubscribeRequests = client.onServerRequest(addServerRequest)
    return () => { unsubscribe(); unsubscribeConnection(); unsubscribeRequests(); client.close() }
  }, [client])

  useEffect(() => {
    if (DEMO || auth !== 'ready') return
    return subscribeBrowserVaultRequests(setBrowserVaultRequests)
  }, [auth])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((value) => !value)
      } else if (event.metaKey && !event.shiftKey && !event.altKey && event.key === ',') {
        event.preventDefault()
        setSettingsTab((tab) => tab ? null : 'general')
      } else if (event.altKey && !event.metaKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        // The displayed order depends on the sort and the collapsed sections: the roster on screen is authoritative.
        const rows = [...document.querySelectorAll<HTMLElement>('[data-bot]')]
        if (!rows.length) return
        event.preventDefault()
        const current = localOpenRef.current ? LOCAL_CHAT_SLUG : useRosterStore.getState().selected
        const at = rows.findIndex((row) => row.dataset.bot === current)
        const target = rows[(at + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]
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
      if (document.hidden) return
      loadRoster(client).then((roster) => {
        setBots((current) => mergeRoster(current, roster.bots, useRosterStore.getState().selected, (slug) => getCached(slug)?.chat.running === true))
      }).catch(() => { /* the connection is reported by the sidebar footer */ })
    }, 30_000)
    return () => clearInterval(timer)
  }, [auth, client])

  // Turns of each bot, profile by profile: a bot woken by another bot goes “Working” within
  // a few seconds, without waiting for the roster re-read or for its chat to be opened. `sessions.changed`
  // brings the next read forward.
  useEffect(() => {
    if (DEMO || auth !== 'ready') return
    let busy = false
    let lastPoll = 0
    const poll = () => {
      if (busy || document.hidden || useRosterStore.getState().bots.length === 0) return
      busy = true
      lastPoll = Date.now()
      loadLiveStatuses(client, useRosterStore.getState().bots.filter((bot) => bot.sessionId).map((bot) => bot.slug)).then(({ statuses, answered }) => {
        for (const bot of useRosterStore.getState().bots) {
          if (!bot.sessionId || !answered.has(bot.slug)) continue
          const live = liveTurnStatus(statuses.get(bot.sessionId))
          const busyNow = bot.status === 'working' || bot.status === 'thinking'
          if (live === 'working' && !busyNow) {
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
    const timer = setInterval(poll, LIVE_STATUS_MS)
    const unsubscribe = client.onEvent((event) => {
      if (event.type === 'sessions.changed' && Date.now() - lastPoll > 2_000) poll()
    })
    return () => { clearInterval(timer); unsubscribe() }
  }, [auth, client])

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
      if (document.hidden) return
      for (const bot of useRosterStore.getState().bots) {
        if ((bot.status !== 'working' && bot.status !== 'thinking') || !bot.sessionId) continue
        // A chat already open on this socket receives its events live.
        if (getCached(bot.slug)?.chat.socketGeneration === client.generation) continue
        loadSessionEvents(client, bot.slug, bot.sessionId, getWorkSeq(bot.slug)).then(({ events, latestSeq }) => {
          setWorkSeq(bot.slug, latestSeq)
          events.forEach((event) => applyWork(bot.slug, event))
        }).catch(() => { /* session outside this process: the row stays “Working” */ })
      }
    }, 20_000)
    return () => clearInterval(timer)
  }, [auth, client])

  useEffect(() => {
    const chat = useChatStore.getState().activeChat
    if (!showUsage || !chat || DEMO) return
    loadUsage(client, chat).then((next) => {
      if (useChatStore.getState().activeChat?.sessionId === chat.sessionId) setUsage(next)
    }).catch(() => setUsage(null))
  }, [showUsage, selected, chatLoading, client])

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

  /** Reloads a Bot Chat. `resumed`: the socket just changed, the server snapshot is authoritative. */
  const syncChat = (profile: string, resumed = false) => {
    const requestId = ++chatRequestRef.current
    const cached = getCached(profile)
    const bot = useRosterStore.getState().bots.find((item) => item.slug === profile)
    return Promise.allSettled([
      openChat(client, profile, cached?.chat.sessionId || bot?.sessionId),
      loadRoutines(profile),
    ]).then(([chatResult, routineResult]) => {
      if (requestId !== chatRequestRef.current) return
      // After a disconnection, the turn may have ended without us: only the recency test then protects the cache.
      const preserveLive = !resumed && Boolean(cached && (useChatStore.getState().activeChat?.running || useChatStore.getState().streaming))
      if (chatResult.status === 'fulfilled') {
        const nextMessages = resolveSyncedMessages(cached, chatResult.value.messages, preserveLive)
        const nextRoutines = routineResult.status === 'fulfilled' ? routineResult.value : cached?.routines || []
        applySyncedChat(profile, { chat: chatResult.value.chat, messages: nextMessages, routines: nextRoutines }, { preserveLive, resumed })
        const openPrompts = chatResult.value.prompts
        replaceSessionPrompts(chatResult.value.chat.sessionId, openPrompts)
        if (chatResult.value.chat.running) updateBot(profile, { status: openPrompts.length ? 'waiting' : 'working' })
      } else if (!cached) {
        setNotice(chatResult.reason instanceof Error ? chatResult.reason.message : i18n.t('app.chatOpenFailed'))
      }
      if (routineResult.status === 'fulfilled') setRoutines(routineResult.value)
      else if (!cached) setRoutines([])
      setChatLoading(false)
      setRoutinesLoading(false)
    })
  }

  /** Starts over with a fresh socket, then resubscribes the open chat: a fresh socket is subscribed to nothing. */
  const reconnect = async () => {
    if (DEMO || useRosterStore.getState().reconnecting) return
    setReconnecting(true)
    setNotice('')
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
    } catch {
      client.close()
      setConnected(false)
      setNotice(i18n.t('app.noResponse'))
    } finally {
      setReconnecting(false)
      setRosterLoaded(true)
    }
  }

  useEffect(() => {
    if (!selected || DEMO) return
    const profile = selected
    enterProfile(profile)
    setModelQuery(null)
    setMobileOpen(false)
    void syncChat(profile)
  }, [selected, client])

  const selectBot = (bot: Bot) => {
    const wasLocal = localOpenRef.current
    localOpenRef.current = bot.slug === LOCAL_CHAT_SLUG
    setLocalOpen(localOpenRef.current)
    if (localOpenRef.current) {
      setLocalStarted(true)
      setMobileOpen(false)
      setFocusSignal((value) => value + 1)
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
    if (!DEMO) showProfileFromList(bot.slug)
    updateBot(bot.slug, { unread: 0 })
    if (DEMO) {
      const demo = demoData(demoLanguage())
      setMessages(demo.messages)
      setRoutines(demo.routines)
      setChatLoading(false)
      setRunning(false)
      setStreaming('')
      setStreamKey('')
      setMobileOpen(false)
    }
  }

  // Without an explicit mode (email card, suggestions), the turn is a normal turn: an approved email must go out.
  const send = async (text: string, attachments: PendingAttachment[], mode: ChatMode = 'exec', delivery?: DeliveryMode): Promise<boolean> => {
    const now = new Date().toISOString()
    if (DEMO) {
      setMessages((items) => [...items,
        { id: `demo-user-${Date.now()}`, role: 'user', content: text, createdAt: now },
        { id: `demo-answer-${Date.now()}`, role: 'assistant', content: i18n.t('app.demoAnswer'), createdAt: new Date().toISOString() },
      ])
      return true
    }
    let chat = useChatStore.getState().activeChat
    if (!chat || chat.profile !== selected) return false
    // A fresh socket is subscribed to nothing: without resuming, prompt.submit answers permission_denied.
    try {
      await client.connect()
      if (chat.socketGeneration !== client.generation) {
        const reopened = await openChat(client, chat.profile, chat.sessionId)
        chat = reopened.chat
        replaceSessionPrompts(chat.sessionId, reopened.prompts)
        setActiveChat(chat)
        updateCachedChat(chat.profile, chat)
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : i18n.t('app.connectFailed'))
      return false
    }
    // During a turn, the composer only lets a queued or priority message through (Wait keeps the draft).
    if (running && delivery !== 'queue' && delivery !== 'priority') return false
    const content = [text, ...attachments.map(attachmentLabel)].join('\n\n')
    clearDoneTimer(selected)
    const userMessage: ChatMessage = { id: `local-${Date.now()}`, role: 'user', content, createdAt: now, ...(running ? { delivery: delivery as 'queue' | 'priority' } : {}) }
    setMessages((items) => [...items, userMessage])
    appendCachedMessage(selected, userMessage)
    if (running) return queueTurn(chat, text, attachments, userMessage, mode, delivery === 'priority')
    updateCachedChat(selected, { running: true })
    updateBot(selected, { preview: text, timestamp: now, status: 'working' })
    setRunning(true)
    setActivity('')
    try {
      const { images, fileRefs } = await uploadAttachments(chat, attachments)
      setActivity('')
      const prompt = withMentionNote([text, ...fileRefs].join('\n\n'), useRosterStore.getState().bots, chat.profile)
      await submitPrompt(client, chat, prompt, images, { apiText: modeApiText(prompt, mode) })
      setActiveChat({ ...chat, running: true })
      return true
    } catch (error) {
      setRunning(false)
      updateCachedChat(selected, { running: false })
      updateBot(selected, { status: 'idle' })
      setActivity('')
      markSendFailed(selected, userMessage, error)
      return false
    }
  }

  const markSendFailed = (profile: string, userMessage: ChatMessage, error: unknown) => {
    // An approved email whose delivery to the bot fails must become a card to approve again.
    setMessages((items) => markMessageFailed(items, userMessage.id))
    markCachedFailed(profile, userMessage.id)
    const message: ChatMessage = { id: `error-${Date.now()}`, role: 'system', content: i18n.t('app.notSent'), createdAt: new Date().toISOString() }
    setMessages((items) => [...items, message])
    appendCachedMessage(profile, message)
    setNotice(error instanceof Error ? error.message : i18n.t('app.sendFailed'))
  }

  const uploadAttachments = async (chat: ActiveChat, attachments: PendingAttachment[]) => {
    const images: { path: string; mime: string }[] = []
    const fileRefs: string[] = []
    for (const attachment of attachments) {
      setActivity(i18n.t('app.sending', { name: attachment.name }))
      const dataUrl = await readDataUrl(attachment.file)
      if (attachment.kind === 'image') images.push(await attachImageBytes(client, chat, attachment.name, dataUrl))
      else fileRefs.push(await attachFile(client, chat, attachment.name, dataUrl))
    }
    return { images, fileRefs }
  }

  /**
   * Message sent during a turn: queued, Hermes starts it when the turn ends. Priority, it goes into
   * the same queue with a resume instruction, then the current turn is interrupted: so it runs right after.
   */
  const queueTurn = async (chat: ActiveChat, text: string, attachments: PendingAttachment[], userMessage: ChatMessage, mode: ChatMode, priority: boolean) => {
    try {
      const { images, fileRefs } = await uploadAttachments(chat, attachments)
      setActivity('')
      const prompt = withMentionNote([text, ...fileRefs].join('\n\n'), useRosterStore.getState().bots, chat.profile)
      const modeText = modeApiText(prompt, mode)
      await submitPrompt(client, chat, prompt, images, { queued: true, apiText: priority ? priorityApiText(prompt, modeText) : modeText })
      if (priority) {
        // The generation of the current turn, read at the last `message.start`: the old one would be refused.
        const open = useChatStore.getState().activeChat
        const current = open?.sessionId === chat.sessionId ? open : chat
        setActivity(i18n.t('app.priorityInterrupt'))
        // Turn already finished: the queued message goes out anyway.
        await interruptChat(client, current).catch(() => setActivity(''))
      }
      return true
    } catch (error) {
      setActivity('')
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
  }, [])

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

  const stop = async () => {
    const chat = useChatStore.getState().activeChat
    if (!chat || DEMO) {
      setRunning(false)
      return
    }
    try {
      setActivity(i18n.t('app.stopping'))
      await interruptChat(client, chat)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : i18n.t('app.interruptFailed'))
    }
  }

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
    setModelsLoading(true)
    setModelsError('')
    loadModelOptions(client, selected, useChatStore.getState().activeChat?.sessionId).then((result) => {
      setModelOptions(result.options)
      if (result.current) setChatModel((value) => value || result.current)
    }).catch((error) => {
      setModelsError(error instanceof Error ? error.message : i18n.t('app.modelsUnavailable'))
    }).finally(() => setModelsLoading(false))
  }

  const selectModel = async (option: ModelOption) => {
    const chat = useChatStore.getState().activeChat
    if (!chat) return
    try {
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
      if (open?.sessionId === chat.sessionId) setActiveChat({ ...open, ...changes })
      updateCachedChat(chat.profile, changes)
      setChatModel(option.model)
      setModelQuery(null)
      if (result?.deferred) setNotice(i18n.t('app.modelDeferred', { model: modelLabel(option.model) }))
    } catch (error) {
      setModelsError(error instanceof Error ? error.message : i18n.t('app.modelSwitchRefused'))
    }
  }

  const answerServerRequest = (id: string, result: Record<string, unknown>) => {
    try {
      client.respond(id, result)
      removeServerRequest(id)
    } catch {
      setNotice(i18n.t('app.disconnectedValidate'))
    }
  }

  /** Rejects if the gateway refuses: the card stays open to try again. */
  const answerPendingPrompt = async (prompt: PendingPrompt, answer: string) => {
    const chat = useChatStore.getState().activeChat
    if (!chat || chat.sessionId !== prompt.sessionId) throw new Error('chat_change')
    try {
      const status = await answerPrompt(client, chat.profile, prompt, answer)
      removePrompt(prompt.promptId)
      if (status === 'already_resolved') setNotice(i18n.t('app.alreadyResolved'))
      else updateBot(chat.profile, { status: 'working' })
    } catch (error) {
      setNotice(error instanceof Error ? i18n.t('app.answerNotSentWith', { message: error.message }) : i18n.t('app.answerNotSent'))
      throw error
    }
  }

  const answerBrowserVault = async (id: string, body: Record<string, unknown>) => {
    await respondBrowserVault(id, body)
    removeBrowserVaultRequest(id)
  }

  const selectedBot = bots.find((bot) => bot.slug === selected) || bots[0]
  const localModel = chooseLocalModel(localModels, settings.localModel)
  const localBot: Bot | null = localModel ? { ...localChatBot(localModel, appConfig.localChat.name), status: localRunning ? 'working' : 'idle' } : null
  localBotRef.current = localBot
  const rosterBots = DEMO || !localBot ? bots : [...bots, localBot]
  const openRequest = serverRequests[0]
  const shownSession = activeChat?.profile === selectedBot?.slug ? activeChat?.sessionId : selectedBot?.sessionId
  const shownPrompts = shownSession ? prompts.filter((prompt) => prompt.sessionId === shownSession) : []
  const openBrowserVaultRequest = browserVaultRequests[0]

  if (auth === 'checking') {
    return <LoadingScreen label={t('loading.opening')} />
  }
  if (auth === 'login') return <Login onLogin={login} onLocalSignIn={retryLocalSignIn} error={authError || notice} />
  if (!selectedBot) {
    if (!rosterLoaded) return <LoadingScreen label={t('loading.bots')} />
    return <div className="app-loading"><p>{t('loading.none')}</p>{notice && <p>{notice}</p>}<button className="connection-retry" disabled={reconnecting} onClick={reconnect}>{reconnecting ? t('loading.reconnecting') : t('loading.reconnect')}</button></div>
  }

  return (
    <div className="app-shell">
      <Sidebar
        bots={rosterBots}
        selected={localOpen ? LOCAL_CHAT_SLUG : selectedBot.slug}
        connected={connected}
        reconnecting={reconnecting}
        onReconnect={reconnect}
        onLogout={logout}
        workSummaries={workSummaries}
        dark={dark}
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
        onSelect={selectBot}
        onNewMessage={() => { setFocusSignal((value) => value + 1); setMobileOpen(false) }}
        onToggleTheme={(origin) => chooseTheme(dark ? 'light' : 'dark', origin)}
        onOpenSettings={() => setSettingsTab('general')}
      />
      <ChatView
        hidden={localOpen}
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
        onOpenDocument={openDocument}
        onOpenBot={openBot}
        modelLabel={modelLabel(chatModel || selectedBot.model)}
        onOpenModels={openModels}
        usage={usage}
        showUsage={showUsage}
        onToggleUsage={() => updateSettings({ showUsage: !showUsage })}
        prompts={shownPrompts}
        onAnswerPrompt={answerPendingPrompt}
        modelPicker={modelQuery !== null ? (
          <ModelPicker
            options={selectableModels(modelOptions, settings.hiddenModels, [chatModel || selectedBot.model, selectedBot.model])}
            current={chatModel || selectedBot.model}
            profileModel={selectedBot.model}
            loading={modelsLoading}
            error={modelsError}
            initialQuery={modelQuery}
            onSelect={selectModel}
            onClose={() => setModelQuery(null)}
            onManage={() => { setModelQuery(null); setSettingsTab('models') }}
          />
        ) : undefined}
      />
      {localStarted && localBot && <LocalChatView bot={localBot} active={localOpen} focusSignal={focusSignal} onOpenMobile={() => setMobileOpen(true)} onNotice={setNotice} onRunningChange={setLocalRunning} />}
      {detailsOpen && !localOpen && (
        <DetailsPanel
          bot={selectedBot}
          work={workSummaries[selectedBot.slug]}
          routines={routines}
          messages={messages}
          loading={routinesLoading}
          running={running}
          usage={usage}
          loadUsageDetails={loadUsageDetails}
          onOpenDocument={openDocument}
          documents={documents}
          railTab={railTab}
          onSelectRailTab={setRailTab}
          onCloseDocument={closeDocument}
          onReloadDocument={reloadDocument}
          onClose={() => setDetailsOpen(false)}
        />
      )}
      {openRequest && <ServerRequestDialog key={openRequest.id} request={openRequest} botName={bots.find((bot) => bot.sessionId === openRequest.params.session_id)?.name || selectedBot.name} onAnswer={answerServerRequest} />}
      {openBrowserVaultRequest && <BrowserVaultDialog key={openBrowserVaultRequest.id} request={openBrowserVaultRequest} botName={bots.find((bot) => bot.slug === openBrowserVaultRequest.bot)?.name || openBrowserVaultRequest.bot} onRespond={answerBrowserVault} />}
      {paletteOpen && <CommandPalette bots={rosterBots} onSelect={(bot) => { setPaletteOpen(false); selectBot(bot) }} onClose={() => setPaletteOpen(false)} />}
      {settingsTab && (
        <SettingsDialog
          tab={settingsTab}
          onSelectTab={setSettingsTab}
          onClose={() => setSettingsTab(null)}
          onChooseTheme={chooseTheme}
          models={modelOptions}
          bots={bots}
          modelsLoading={modelsLoading}
          modelsError={modelsError}
          onLoadModels={refreshModels}
          connected={connected}
          reconnecting={reconnecting}
          onReconnect={reconnect}
          onLogout={logout}
        />
      )}
      {notice && <div className="toast" role="status"><AlertCircle size={17} /><span>{notice}</span><button aria-label={t('app.close')} onClick={() => setNotice('')}><X size={15} /></button></div>}
      {DEMO && <div className="demo-badge">{t('app.demoBadge')}</div>}
    </div>
  )
}
