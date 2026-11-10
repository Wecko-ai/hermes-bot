import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { AlertCircle, X } from 'lucide-react'
import type { Bot, ChatMessage, ModelOption, Routine, SessionUsage } from './types'
import { answerPrompt, attachFile, attachImageBytes, HermesClient, interruptChat, isSilentMessage, liveTurnStatus, loadContextBreakdown, loadLiveStatuses, loadModelOptions, loadRoster, loadRoutines, loadSessionEvents, loadUsage, loadUsageHistory, mergeUsage, openChat, parsePendingPrompt, parseUsage, submitPrompt, switchModel, type ActiveChat, type PendingPrompt, type ServerRequest } from './lib/hermes'
import { mergeRoster } from './lib/activity'
import { applyWorkEvent, workLine, type WorkSummary } from './lib/work-summary'
import { modelLabel } from './lib/model'
import { ModelPicker } from './components/ModelPicker'
import { demoBots, demoMessages, demoRoutines, demoUsageDetails, demoWork } from './lib/demo'
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
import { respondBrowserVault, subscribeBrowserVaultRequests, type BrowserVaultRequest } from './lib/browser-vault'
import { attachmentLabel, readDataUrl, type PendingAttachment } from './lib/attachments'
import { withMentionNote } from './lib/mentions'
import { agentChatMessages, agentMessagesFromEvent } from './lib/inter-agent'
import { modeApiText, type ChatMode } from './lib/modes'
import { priorityApiText, type DeliveryMode } from './lib/delivery'
import { LOCAL_CHAT_BOT, LOCAL_CHAT_SLUG } from './lib/local-chat'
import type { MediaRef } from './lib/media'
import { SettingsDialog, type SettingsTab } from './components/SettingsDialog'
import { getSettings, selectableModels, updateSettings, useSettings, type ThemeChoice } from './lib/settings'

const DEMO = new URLSearchParams(location.search).get('demo') === '1'
const MAX_OPEN_DOCUMENTS = 8
/** Lecture des tours de tous les bots. Hermes Desktop relit son roster toutes les 5 s. */
const LIVE_STATUS_MS = 6_000
const asText = (value: unknown) => typeof value === 'string' ? value : ''

interface ChatCacheEntry {
  chat: ActiveChat
  messages: ChatMessage[]
  routines: Routine[]
}

function latestMessageTime(messages: ChatMessage[]) {
  return messages.reduce((latest, message) => Math.max(latest, message.createdAt ? Date.parse(message.createdAt) : 0), 0)
}

const systemPrefersDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches || false

/** Bascule de thème en révélation circulaire depuis le bouton (View Transitions), instantanée sinon. */
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
  }).catch(() => { /* transition interrompue : le thème est déjà appliqué */ })
}

export default function App() {
  const clientRef = useRef<HermesClient | null>(null)
  if (!clientRef.current) clientRef.current = new HermesClient()
  const client = clientRef.current
  const activeChatRef = useRef<ActiveChat | null>(null)
  const selectedRef = useRef('')
  const botsRef = useRef<Bot[]>(DEMO ? demoBots : [])
  const streamingRef = useRef('')
  const chatRequestRef = useRef(0)
  const chatCacheRef = useRef(new Map<string, ChatCacheEntry>())
  const doneTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const initializedRef = useRef(false)

  const [auth, setAuth] = useState<'checking' | 'login' | 'ready'>(DEMO ? 'ready' : 'checking')
  // Tant que le roster n’a pas répondu, une liste vide veut dire « pas encore », pas « aucun bot ».
  const [rosterLoaded, setRosterLoaded] = useState(DEMO)
  const [authError, setAuthError] = useState('')
  const [bots, setBots] = useState<Bot[]>(DEMO ? demoBots : [])
  const [selected, setSelected] = useState(DEMO ? 'nova' : '')
  const [messages, setMessages] = useState<ChatMessage[]>(DEMO ? demoMessages : [])
  const [routines, setRoutines] = useState<Routine[]>(DEMO ? demoRoutines : [])
  const [routinesLoading, setRoutinesLoading] = useState(false)
  const [chatLoading, setChatLoading] = useState(!DEMO)
  const [streaming, setStreamingState] = useState('')
  const [running, setRunning] = useState(false)
  const [activity, setActivity] = useState('')
  const [connected, setConnected] = useState(DEMO)
  const [reconnecting, setReconnecting] = useState(false)
  const reconnectingRef = useRef(false)
  const [serverRequests, setServerRequests] = useState<ServerRequest[]>([])
  /** Questions et accords ouverts des sessions suivies sur ce socket (`clarify.request`, `approval.request`). */
  const [prompts, setPrompts] = useState<PendingPrompt[]>([])
  const [browserVaultRequests, setBrowserVaultRequests] = useState<BrowserVaultRequest[]>([])
  const workRef = useRef(new Map<string, WorkSummary>())
  const workSeqRef = useRef(new Map<string, number>())
  const [workSummaries, setWorkSummaries] = useState<Record<string, WorkSummary>>(DEMO ? demoWork : {})
  const [detailsOpen, setDetailsOpen] = useState(() => window.innerWidth >= 1180)
  const [mobileOpen, setMobileOpen] = useState(false)
  const settings = useSettings()
  const { showUsage } = settings
  const [systemDark, setSystemDark] = useState(systemPrefersDark)
  const dark = settings.theme === 'system' ? systemDark : settings.theme === 'dark'
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null)
  const [focusSignal, setFocusSignal] = useState(0)
  const [notice, setNotice] = useState('')
  const [chatModel, setChatModel] = useState('')
  const [usage, setUsage] = useState<SessionUsage | null>(null)
  const [modelQuery, setModelQuery] = useState<string | null>(null)
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState('')
  const [documents, setDocuments] = useState<OpenDocument[]>([])
  const [railTab, setRailTab] = useState(BOT_RAIL_TAB)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [localOpen, setLocalOpen] = useState(false)
  const localOpenRef = useRef(false)
  // Montée à la première ouverture, puis gardée : une réponse continue pendant qu’on regarde un autre bot.
  const [localStarted, setLocalStarted] = useState(false)
  const [localRunning, setLocalRunning] = useState(false)

  const setStreaming = (value: string | ((current: string) => string)) => {
    const next = typeof value === 'function' ? value(streamingRef.current) : value
    streamingRef.current = next
    setStreamingState(next)
  }
  // Identifiant du tour en cours : la bulle de streaming et le message final le partagent,
  // React garde donc le même élément (une vidéo en lecture continue).
  const streamKeyRef = useRef('')
  const [streamKey, setStreamKeyState] = useState('')
  const setStreamKey = (value: string) => {
    streamKeyRef.current = value
    setStreamKeyState(value)
  }
  const updateBot = (slug: string, changes: Partial<Bot>) => {
    setBots((current) => current.map((bot) => bot.slug === slug ? { ...bot, ...changes } : bot))
  }
  const clearDoneTimer = (slug: string) => {
    const timer = doneTimersRef.current.get(slug)
    if (timer) clearTimeout(timer)
    doneTimersRef.current.delete(slug)
  }
  const applyWork = (slug: string, event: Parameters<typeof applyWorkEvent>[1]) => {
    const next = applyWorkEvent(workRef.current.get(slug), event)
    if (next) workRef.current.set(slug, next)
    else workRef.current.delete(slug)
  }
  const markDone = (slug: string) => {
    clearDoneTimer(slug)
    // Un worker du bot tourne encore : le tour de chat est fini, pas son travail.
    if (botsRef.current.find((bot) => bot.slug === slug)?.workerActive) {
      updateBot(slug, { status: 'working' })
      return
    }
    updateBot(slug, { status: 'done' })
    doneTimersRef.current.set(slug, setTimeout(() => updateBot(slug, { status: 'idle' }), 5000))
  }
  const updateCachedChat = (profile: string, changes: Partial<ActiveChat>) => {
    const cached = chatCacheRef.current.get(profile)
    if (cached) chatCacheRef.current.set(profile, { ...cached, chat: { ...cached.chat, ...changes } })
  }
  const appendCachedMessage = (profile: string, message: ChatMessage) => {
    const cached = chatCacheRef.current.get(profile)
    if (cached) chatCacheRef.current.set(profile, { ...cached, messages: [...cached.messages, message] })
  }
  /** Un tour suivi en direct sur ce socket : ses événements disent eux-mêmes quand il finit. */
  const followedLive = (slug: string) => {
    const cached = chatCacheRef.current.get(slug)?.chat
    return Boolean(cached?.running && cached.socketGeneration === client.generation)
  }

  useEffect(() => {
    selectedRef.current = selected
  }, [selected])

  useEffect(() => {
    botsRef.current = bots
  }, [bots])

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
      const current = activeChatRef.current
      const currentSession = current?.sessionId
      const isCurrent = Boolean(currentSession && event.session_id === currentSession)
      const payload = event.payload || {}
      if (event.type === 'request.cancel') {
        setServerRequests((items) => items.filter((item) => item.id !== payload.id))
        return
      }
      // Question ou accord du bot : le tour reste bloqué jusqu’à la réponse de l’utilisateur (carte au-dessus du champ).
      if ((event.type === 'clarify.request' || event.type === 'approval.request') && event.session_id) {
        const prompt = parsePendingPrompt(event.session_id, payload)
        if (prompt) {
          setPrompts((items) => items.some((item) => item.promptId === prompt.promptId) ? items : [...items, prompt])
          const owner = isCurrent && current ? current.profile : botsRef.current.find((bot) => bot.sessionId === event.session_id)?.slug
          if (owner) {
            clearDoneTimer(owner)
            updateBot(owner, { status: 'waiting' })
          }
        }
        return
      }
      if ((event.type === 'clarify.settled' || event.type === 'approval.settled') && event.session_id) {
        const promptId = asText(payload.prompt_id)
        setPrompts((items) => items.filter((item) => !(item.sessionId === event.session_id && item.promptId === promptId)))
        const owner = botsRef.current.find((bot) => isCurrent && current ? bot.slug === current.profile : bot.sessionId === event.session_id)
        // Réponse donnée ici ou ailleurs : le bot reprend son tour. La lecture des tours corrige s’il reste une question.
        if (owner?.status === 'waiting') updateBot(owner.slug, { status: 'working' })
        return
      }
      // Un tour fini n’attend plus rien.
      if (event.type === 'message.complete' && event.session_id) {
        setPrompts((items) => items.some((item) => item.sessionId === event.session_id) ? items.filter((item) => item.sessionId !== event.session_id) : items)
      }
      const workOwner = isCurrent && current ? current.profile : event.session_id ? botsRef.current.find((bot) => bot.sessionId === event.session_id)?.slug : undefined
      if (workOwner) applyWork(workOwner, event)
      // « Orion messaged Iris » : appel `message_agent` en direct, ou tour lancé par le message d’un autre bot.
      const agentNotes = workOwner ? agentChatMessages(
        agentMessagesFromEvent(event.type, payload, workOwner),
        `live-${asText(payload.tool_id) || asText(payload.turn_id) || Date.now()}`,
        new Date().toISOString(),
      ) : []
      if (workOwner && agentNotes.length) {
        const fresh = (items: ChatMessage[]) => agentNotes.filter((note) => !items.some((item) => item.id === note.id))
        if (isCurrent) setMessages((items) => [...items, ...fresh(items)])
        const cached = chatCacheRef.current.get(workOwner)
        if (cached) chatCacheRef.current.set(workOwner, { ...cached, messages: [...cached.messages, ...fresh(cached.messages)] })
      }
      // Un bot déjà ouvert qui démarre un tour en arrière-plan passe « au travail » tout de suite,
      // sans attendre la relecture du roster (30 s). Le cache n’est pas marqué : si la fin du tour
      // se perdait, la relecture suivante remettrait le bon statut au lieu de le figer.
      if (event.type === 'message.start' && event.session_id && !isCurrent) {
        const owner = botsRef.current.find((bot) => bot.sessionId === event.session_id)
        if (owner && owner.slug !== selectedRef.current) {
          clearDoneTimer(owner.slug)
          if (owner.status !== 'working') updateBot(owner.slug, { status: 'working' })
        }
      }
      if (event.type === 'message.complete' && event.session_id && !isCurrent) {
        const owner = botsRef.current.find((bot) => bot.sessionId === event.session_id)
        const finalText = typeof payload.text === 'string' ? payload.text : ''
        if (owner && owner.slug !== selectedRef.current) {
          const meaningful = finalText.trim() && !isSilentMessage(finalText)
          appendCachedMessage(owner.slug, {
            id: `background-${Date.now()}`, role: meaningful ? 'assistant' : 'system', content: finalText || '[NO_REPLY]', createdAt: new Date().toISOString(), technical: !meaningful,
          })
          updateCachedChat(owner.slug, { running: false })
          markDone(owner.slug)
          const finishedAt = new Date().toISOString()
          // Tant qu’un worker tourne, le non-lu attend la relecture qui verra le bot arrêté.
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
        // Le cache lu n’existe que dans les compteurs de la trame, pas dans sa vue `usage`.
        const next = parseUsage({ ...payload, ...(payload.usage as object | undefined) })
        if (next) setUsage((value) => mergeUsage(value, next))
      }
      if (event.type === 'message.start') {
        // `session.steer` et `session.interrupt` visent ce tour-ci, pas le précédent.
        if (event.execution_generation) activeChatRef.current = { ...current, executionGeneration: event.execution_generation }
        setStreamKey(`turn-${typeof payload.turn_id === 'string' && payload.turn_id ? payload.turn_id : 'tour'}-${Date.now()}`)
        clearDoneTimer(current.profile)
        setRunning(true)
        updateCachedChat(current.profile, { running: true })
        updateBot(current.profile, { status: 'working' })
      }
      if (event.type === 'message.delta') {
        const text = typeof payload.text === 'string' ? payload.text : ''
        if (text && !streamKeyRef.current) setStreamKey(`turn-tour-${Date.now()}`)
        if (text) setStreaming((value) => value + text)
        setRunning(true)
      }
      if (event.type === 'tool.start') {
        setActivity(typeof payload.name === 'string' ? payload.name.replaceAll('_', ' ') : 'Outil en cours')
      }
      if (event.type === 'tool.complete') setActivity('')
      if (event.type === 'message.complete') {
        const status = typeof payload.status === 'string' ? payload.status : 'complete'
        const finalUsage = parseUsage(payload.usage)
        if (finalUsage) setUsage((value) => mergeUsage(value, finalUsage))
        const finalText = typeof payload.text === 'string' && payload.text.trim() ? payload.text : streamingRef.current
        if (finalText.trim() && !isSilentMessage(finalText)) {
          const message: ChatMessage = {
            id: streamKeyRef.current || `live-${Date.now()}`,
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
          const message: ChatMessage = { id: `interrupted-${Date.now()}`, role: 'system', content: 'Tour interrompu.', createdAt: new Date().toISOString() }
          setMessages((items) => [...items, message])
          appendCachedMessage(current.profile, message)
        }
        setStreaming('')
        setStreamKey('')
        setRunning(false)
        updateCachedChat(current.profile, { running: false })
        setActivity('')
        markDone(current.profile)
        if (event.execution_generation) activeChatRef.current = { ...current, executionGeneration: event.execution_generation, running: false }
      }
    })
    const unsubscribeConnection = client.onConnection(setConnected)
    const unsubscribeRequests = client.onServerRequest((request) => {
      setServerRequests((items) => items.some((item) => item.id === request.id) ? items : [...items, request])
    })
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
        // L’ordre affiché dépend du tri et des sections repliées : le roster à l’écran fait foi.
        const rows = [...document.querySelectorAll<HTMLElement>('[data-bot]')]
        if (!rows.length) return
        event.preventDefault()
        const current = localOpenRef.current ? LOCAL_CHAT_SLUG : selectedRef.current
        const at = rows.findIndex((row) => row.dataset.bot === current)
        const target = rows[(at + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]
        const bot = target.dataset.bot === LOCAL_CHAT_SLUG ? LOCAL_CHAT_BOT : botsRef.current.find((item) => item.slug === target.dataset.bot)
        if (bot) selectBot(bot)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Un fichier lâché hors du chat ne doit pas remplacer l’app par son contenu.
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
        setBots((current) => mergeRoster(current, roster.bots, selectedRef.current, (slug) => chatCacheRef.current.get(slug)?.chat.running === true))
      }).catch(() => { /* la connexion est signalée par le pied de la sidebar */ })
    }, 30_000)
    return () => clearInterval(timer)
  }, [auth, client])

  // Tours de chaque bot, profil par profil : un bot réveillé par un autre bot passe « Au travail » en
  // quelques secondes, sans attendre la relecture du roster ni l’ouverture de son chat. `sessions.changed`
  // avance la lecture suivante.
  useEffect(() => {
    if (DEMO || auth !== 'ready') return
    let busy = false
    let lastPoll = 0
    const poll = () => {
      if (busy || document.hidden || botsRef.current.length === 0) return
      busy = true
      lastPoll = Date.now()
      loadLiveStatuses(client, botsRef.current.filter((bot) => bot.sessionId).map((bot) => bot.slug)).then(({ statuses, answered }) => {
        for (const bot of botsRef.current) {
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
    // Les événements arrivent en rafale : le résumé affiché se rafraîchit à son rythme, sans clignoter.
    const timer = setInterval(() => {
      if (document.hidden) return
      const next = Object.fromEntries(workRef.current)
      setWorkSummaries((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next)
    }, 4000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (DEMO || auth !== 'ready') return
    const timer = setInterval(() => {
      if (document.hidden) return
      for (const bot of botsRef.current) {
        if ((bot.status !== 'working' && bot.status !== 'thinking') || !bot.sessionId) continue
        // Un chat déjà ouvert sur ce socket reçoit ses événements en direct.
        if (chatCacheRef.current.get(bot.slug)?.chat.socketGeneration === client.generation) continue
        loadSessionEvents(client, bot.slug, bot.sessionId, workSeqRef.current.get(bot.slug) ?? 0).then(({ events, latestSeq }) => {
          workSeqRef.current.set(bot.slug, latestSeq)
          events.forEach((event) => applyWork(bot.slug, event))
        }).catch(() => { /* session hors de ce processus : la ligne reste « Au travail » */ })
      }
    }, 20_000)
    return () => clearInterval(timer)
  }, [auth, client])

  useEffect(() => {
    const chat = activeChatRef.current
    if (!showUsage || !chat || DEMO) return
    loadUsage(client, chat).then((next) => {
      if (activeChatRef.current?.sessionId === chat.sessionId) setUsage(next)
    }).catch(() => setUsage(null))
  }, [showUsage, selected, chatLoading, client])

  const initialize = async () => {
    setAuthError('')
    setRosterLoaded(false)
    try {
      await client.connect()
      const roster = await loadRoster(client)
      setBots(roster.bots)
      setConnected(true)
      setAuth('ready')
      const preferred = roster.bots.find((bot) => !bot.hidden)
      if (preferred) setSelected((current) => current || preferred.slug)
      if (roster.bots.length === 0) setNotice('Aucun bot Hermes visible. Les profils système sont volontairement masqués.')
    } catch (error) {
      setConnected(false)
      setNotice(error instanceof Error ? error.message : 'Connexion à Hermes impossible.')
    } finally {
      setRosterLoaded(true)
    }
  }

  useEffect(() => {
    if (DEMO || initializedRef.current) return
    initializedRef.current = true
    fetch('/api/auth/me', { credentials: 'same-origin' }).then(async (response) => {
      if (response.status === 401) {
        if (await restoreSession()) {
          setAuth('ready')
          await initialize()
        } else setAuth('login')
      }
      else if (!response.ok) throw new Error('Gateway Hermes indisponible.')
      else {
        setAuth('ready')
        await initialize()
      }
    }).catch((error) => {
      setNotice(error instanceof Error ? error.message : 'Gateway Hermes indisponible.')
      setAuth('login')
    })
  }, [])

  /** Session Hermes expirée : nouvelle connexion avec les identifiants gardés dans le Trousseau. */
  const restoreSession = async () => {
    const response = await fetch('/api/auth/restore', { method: 'POST', credentials: 'same-origin' })
    if (response.status === 401) setNotice('Identifiants enregistrés refusés : reconnecte-toi.')
    return response.ok
  }

  const logout = async () => {
    if (DEMO || !window.confirm('Te déconnecter et oublier les identifiants enregistrés sur ce Mac ?')) return
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
      setAuthError(response.status === 401 ? 'Identifiant ou mot de passe incorrect.' : 'La gateway refuse la connexion.')
      return
    }
    setRosterLoaded(false)
    setAuth('ready')
    await reconnect()
  }

  /** Recharge un Bot Chat. `resumed` : le socket vient de changer, le snapshot serveur fait foi. */
  const syncChat = (profile: string, resumed = false) => {
    const requestId = ++chatRequestRef.current
    const cached = chatCacheRef.current.get(profile)
    const bot = botsRef.current.find((item) => item.slug === profile)
    return Promise.allSettled([
      openChat(client, profile, cached?.chat.sessionId || bot?.sessionId),
      loadRoutines(profile),
    ]).then(([chatResult, routineResult]) => {
      if (requestId !== chatRequestRef.current) return
      // Après une coupure, le tour a pu finir sans nous : seul le test de récence protège alors le cache.
      const preserveLive = !resumed && Boolean(cached && (activeChatRef.current?.running || streamingRef.current))
      if (chatResult.status === 'fulfilled') {
        const newerCache = cached && latestMessageTime(cached.messages) > latestMessageTime(chatResult.value.messages)
        const nextMessages = (preserveLive || newerCache) && cached ? cached.messages : chatResult.value.messages
        const nextRoutines = routineResult.status === 'fulfilled' ? routineResult.value : cached?.routines || []
        chatCacheRef.current.set(profile, { chat: chatResult.value.chat, messages: nextMessages, routines: nextRoutines })
        activeChatRef.current = chatResult.value.chat
        setChatModel(chatResult.value.chat.model || '')
        if (!preserveLive) setMessages(nextMessages)
        setRunning(chatResult.value.chat.running)
        const openPrompts = chatResult.value.prompts
        const sessionId = chatResult.value.chat.sessionId
        setPrompts((items) => [...items.filter((item) => item.sessionId !== sessionId), ...openPrompts])
        if (chatResult.value.chat.running) updateBot(profile, { status: openPrompts.length ? 'waiting' : 'working' })
        else if (resumed) {
          setStreaming('')
          setStreamKey('')
          setActivity('')
        }
      } else if (!cached) {
        setNotice(chatResult.reason instanceof Error ? chatResult.reason.message : 'Impossible d’ouvrir ce Bot Chat.')
      }
      if (routineResult.status === 'fulfilled') setRoutines(routineResult.value)
      else if (!cached) setRoutines([])
      setChatLoading(false)
      setRoutinesLoading(false)
    })
  }

  /** Repart d’un socket neuf, puis réabonne le chat ouvert : un socket neuf n’est abonné à rien. */
  const reconnect = async () => {
    if (DEMO || reconnectingRef.current) return
    reconnectingRef.current = true
    setReconnecting(true)
    setNotice('')
    try {
      await window.hermesBot?.restartTunnel()
      const session = await fetch('/api/auth/me', { credentials: 'same-origin' })
      if (session.status === 401 && !(await restoreSession())) {
        client.close()
        setConnected(false)
        setNotice((current) => current || 'Session Hermes expirée : reconnecte-toi.')
        setAuth('login')
        return
      }
      if (session.status !== 401 && !session.ok) throw new Error('gateway_indisponible')
      client.close()
      if (botsRef.current.length === 0) {
        await initialize()
        return
      }
      await client.connect()
      // Les tours suivis avant la coupure ne sont plus écoutés : le roster relu dit lesquels tournent encore.
      chatCacheRef.current.forEach((entry, slug) => {
        if (entry.chat.running) updateCachedChat(slug, { running: false })
      })
      const roster = await loadRoster(client)
      setBots((current) => mergeRoster(current, roster.bots, selectedRef.current, () => false))
      if (selectedRef.current) await syncChat(selectedRef.current, true)
    } catch {
      client.close()
      setConnected(false)
      setNotice('Hermes ne répond pas. Vérifie le réseau, puis réessaie avec ↻.')
    } finally {
      reconnectingRef.current = false
      setReconnecting(false)
      setRosterLoaded(true)
    }
  }

  useEffect(() => {
    if (!selected || DEMO) return
    const profile = selected
    const cached = chatCacheRef.current.get(profile)
    setStreaming('')
    setStreamKey('')
    setActivity('')
    setUsage(null)
    setModelQuery(null)
    setMobileOpen(false)
    if (cached) {
      activeChatRef.current = cached.chat
      setChatModel(cached.chat.model || '')
      setMessages(cached.messages)
      setRoutines(cached.routines)
      setRunning(cached.chat.running)
      setChatLoading(false)
      setRoutinesLoading(false)
    } else {
      activeChatRef.current = null
      setChatModel('')
      setMessages([])
      setRoutines([])
      setRunning(false)
      setChatLoading(true)
      setRoutinesLoading(true)
    }
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
    if (wasLocal && selectedRef.current === bot.slug) {
      setMobileOpen(false)
      return
    }
    if (selectedRef.current === bot.slug) {
      setMobileOpen(false)
      setFocusSignal((value) => value + 1)
      return
    }
    selectedRef.current = bot.slug
    if (!DEMO) {
      const cached = chatCacheRef.current.get(bot.slug)
      activeChatRef.current = cached?.chat || null
      setChatLoading(!cached)
      setRoutinesLoading(!cached)
      setMessages(cached?.messages || [])
      setRoutines(cached?.routines || [])
      setStreaming('')
      setStreamKey('')
      setActivity('')
      setRunning(cached?.chat.running || false)
    }
    setSelected(bot.slug)
    updateBot(bot.slug, { unread: 0 })
    if (DEMO) {
      setMessages(demoMessages)
      setRoutines(demoRoutines)
      setChatLoading(false)
      setRunning(false)
      setStreaming('')
      setStreamKey('')
      setMobileOpen(false)
    }
  }

  // Sans mode explicite (carte de mail, suggestions), le tour est un tour normal : un mail validé doit partir.
  const send = async (text: string, attachments: PendingAttachment[], mode: ChatMode = 'exec', delivery?: DeliveryMode): Promise<boolean> => {
    const now = new Date().toISOString()
    if (DEMO) {
      setMessages((items) => [...items,
        { id: `demo-user-${Date.now()}`, role: 'user', content: text, createdAt: now },
        { id: `demo-answer-${Date.now()}`, role: 'assistant', content: 'Mode démo visuel : connecte-toi à Hermes pour recevoir une vraie réponse.', createdAt: new Date().toISOString() },
      ])
      return true
    }
    let chat = activeChatRef.current
    if (!chat || chat.profile !== selected) return false
    // Un socket neuf n’est abonné à rien : sans reprise, prompt.submit répond permission_denied.
    try {
      await client.connect()
      if (chat.socketGeneration !== client.generation) {
        const reopened = await openChat(client, chat.profile, chat.sessionId)
        chat = reopened.chat
        const sessionId = chat.sessionId
        setPrompts((items) => [...items.filter((item) => item.sessionId !== sessionId), ...reopened.prompts])
        activeChatRef.current = chat
        updateCachedChat(chat.profile, chat)
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Connexion à Hermes impossible.')
      return false
    }
    // Pendant un tour, le composer ne laisse partir qu’un message en file ou prioritaire (Attendre garde le brouillon).
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
      const prompt = withMentionNote([text, ...fileRefs].join('\n\n'), botsRef.current, chat.profile)
      await submitPrompt(client, chat, prompt, images, { apiText: modeApiText(prompt, mode) })
      activeChatRef.current = { ...chat, running: true }
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
    // Un mail approuvé dont l’envoi au bot échoue doit redevenir une carte à valider.
    const markFailed = (items: ChatMessage[]) => items.map((item) => item.id === userMessage.id ? { ...item, failed: true } : item)
    setMessages(markFailed)
    const cachedChat = chatCacheRef.current.get(profile)
    if (cachedChat) chatCacheRef.current.set(profile, { ...cachedChat, messages: markFailed(cachedChat.messages) })
    const message: ChatMessage = { id: `error-${Date.now()}`, role: 'system', content: 'Le message n’a pas été envoyé. Vérifie la connexion avant de réessayer.', createdAt: new Date().toISOString() }
    setMessages((items) => [...items, message])
    appendCachedMessage(profile, message)
    setNotice(error instanceof Error ? error.message : 'Échec de l’envoi.')
  }

  const uploadAttachments = async (chat: ActiveChat, attachments: PendingAttachment[]) => {
    const images: { path: string; mime: string }[] = []
    const fileRefs: string[] = []
    for (const attachment of attachments) {
      setActivity(`Envoi de ${attachment.name}…`)
      const dataUrl = await readDataUrl(attachment.file)
      if (attachment.kind === 'image') images.push(await attachImageBytes(client, chat, attachment.name, dataUrl))
      else fileRefs.push(await attachFile(client, chat, attachment.name, dataUrl))
    }
    return { images, fileRefs }
  }

  /**
   * Message envoyé pendant un tour : en file, Hermes le lance quand le tour finit. Prioritaire, il part dans
   * la même file avec une consigne de reprise, puis le tour en cours est interrompu : il passe donc juste après.
   */
  const queueTurn = async (chat: ActiveChat, text: string, attachments: PendingAttachment[], userMessage: ChatMessage, mode: ChatMode, priority: boolean) => {
    try {
      const { images, fileRefs } = await uploadAttachments(chat, attachments)
      setActivity('')
      const prompt = withMentionNote([text, ...fileRefs].join('\n\n'), botsRef.current, chat.profile)
      const modeText = modeApiText(prompt, mode)
      await submitPrompt(client, chat, prompt, images, { queued: true, apiText: priority ? priorityApiText(prompt, modeText) : modeText })
      if (priority) {
        // La génération du tour en cours, lue au dernier `message.start` : l’ancienne serait refusée.
        const current = activeChatRef.current?.sessionId === chat.sessionId ? activeChatRef.current : chat
        setActivity('Interruption pour le message prioritaire…')
        // Tour déjà fini : le message en file part quand même.
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
    const bot = botsRef.current.find((item) => item.slug === slug)
    if (bot) selectBot(bot)
  }, [])

  /** Trois lectures indépendantes : une gateway qui n’en connaît qu’une partie affiche quand même le reste. */
  const loadUsageDetails = async (): Promise<UsageDetails> => {
    if (DEMO) return demoUsageDetails
    const chat = activeChatRef.current
    const [usageResult, contextResult, historyResult] = await Promise.allSettled([
      chat ? loadUsage(client, chat) : Promise.resolve(null),
      chat ? loadContextBreakdown(client, chat) : Promise.resolve(null),
      loadUsageHistory(selectedRef.current),
    ])
    return {
      usage: usageResult.status === 'fulfilled' ? usageResult.value : null,
      context: contextResult.status === 'fulfilled' ? contextResult.value : null,
      history: historyResult.status === 'fulfilled' ? historyResult.value : null,
    }
  }

  const stop = async () => {
    const chat = activeChatRef.current
    if (!chat || DEMO) {
      setRunning(false)
      return
    }
    try {
      setActivity('Arrêt en cours…')
      await interruptChat(client, chat)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Impossible d’interrompre le tour.')
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
    loadModelOptions(client, selected, activeChatRef.current?.sessionId).then((result) => {
      setModelOptions(result.options)
      if (result.current) setChatModel((value) => value || result.current)
    }).catch((error) => {
      setModelsError(error instanceof Error ? error.message : 'Modèles indisponibles.')
    }).finally(() => setModelsLoading(false))
  }

  const selectModel = async (option: ModelOption) => {
    const chat = activeChatRef.current
    if (!chat) return
    try {
      let result = await switchModel(client, chat, option)
      if (result?.confirm_required && typeof result.confirm === 'string') {
        if (!window.confirm(result.confirm_message || `Confirmer ${option.model} ?`)) return
        result = await switchModel(client, chat, option, result.confirm)
      }
      const changes: Partial<ActiveChat> = {
        model: option.model,
        ...(typeof result?.revision === 'number' ? { revision: result.revision } : {}),
        ...(typeof result?.execution_generation === 'number' ? { executionGeneration: result.execution_generation } : {}),
      }
      if (activeChatRef.current?.sessionId === chat.sessionId) activeChatRef.current = { ...activeChatRef.current, ...changes }
      updateCachedChat(chat.profile, changes)
      setChatModel(option.model)
      setModelQuery(null)
      if (result?.deferred) setNotice(`${modelLabel(option.model)} sera utilisé au prochain tour.`)
    } catch (error) {
      setModelsError(error instanceof Error ? error.message : 'Changement de modèle refusé.')
    }
  }

  const answerServerRequest = (id: string, result: Record<string, unknown>) => {
    try {
      client.respond(id, result)
      setServerRequests((items) => items.filter((item) => item.id !== id))
    } catch {
      setNotice('Hermes est déconnecté : reconnecte-toi, puis valide de nouveau.')
    }
  }

  /** Rejette si la gateway refuse : la carte reste ouverte pour réessayer. */
  const answerPendingPrompt = async (prompt: PendingPrompt, answer: string) => {
    const chat = activeChatRef.current
    if (!chat || chat.sessionId !== prompt.sessionId) throw new Error('chat_change')
    try {
      const status = await answerPrompt(client, chat.profile, prompt, answer)
      setPrompts((items) => items.filter((item) => item.promptId !== prompt.promptId))
      if (status === 'already_resolved') setNotice('Le bot n’attendait plus cette réponse : délai dépassé ou réponse déjà donnée.')
      else updateBot(chat.profile, { status: 'working' })
    } catch (error) {
      setNotice(error instanceof Error ? `Réponse non transmise : ${error.message}` : 'Réponse non transmise.')
      throw error
    }
  }

  const answerBrowserVault = async (id: string, body: Record<string, unknown>) => {
    await respondBrowserVault(id, body)
    setBrowserVaultRequests((items) => items.filter((item) => item.id !== id))
  }

  const selectedBot = bots.find((bot) => bot.slug === selected) || bots[0]
  const localBot: Bot = { ...LOCAL_CHAT_BOT, status: localRunning ? 'working' : 'idle' }
  const rosterBots = DEMO ? bots : [...bots, localBot]
  const openRequest = serverRequests[0]
  const shownSession = activeChatRef.current?.profile === selectedBot?.slug ? activeChatRef.current?.sessionId : selectedBot?.sessionId
  const shownPrompts = shownSession ? prompts.filter((prompt) => prompt.sessionId === shownSession) : []
  const openBrowserVaultRequest = browserVaultRequests[0]

  if (auth === 'checking') {
    return <LoadingScreen label="Ouverture de HermesBot…" />
  }
  if (auth === 'login') return <Login onLogin={login} error={authError || notice} />
  if (!selectedBot) {
    if (!rosterLoaded) return <LoadingScreen label="Chargement de tes bots…" />
    return <div className="app-loading"><p>Aucun bot à afficher.</p>{notice && <p>{notice}</p>}<button className="connection-retry" disabled={reconnecting} onClick={reconnect}>{reconnecting ? 'Reconnexion…' : 'Reconnecter Hermes'}</button></div>
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
      {localStarted && <LocalChatView bot={localBot} active={localOpen} focusSignal={focusSignal} onOpenMobile={() => setMobileOpen(true)} onNotice={setNotice} onRunningChange={setLocalRunning} />}
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
      {notice && <div className="toast" role="status"><AlertCircle size={17} /><span>{notice}</span><button aria-label="Fermer" onClick={() => setNotice('')}><X size={15} /></button></div>}
      {DEMO && <div className="demo-badge">Démo visuelle</div>}
    </div>
  )
}
