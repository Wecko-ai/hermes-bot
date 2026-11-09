import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { AlertCircle, X } from 'lucide-react'
import type { Bot, ChatMessage, ModelOption, Routine, SessionUsage } from './types'
import { HermesClient, interruptChat, isSilentMessage, loadModelOptions, loadRoster, loadRoutines, loadSessionEvents, loadUsage, openChat, parseUsage, submitPrompt, switchModel, type ActiveChat, type ServerRequest } from './lib/hermes'
import { mergeRoster } from './lib/activity'
import { applyWorkEvent, workLine, type WorkSummary } from './lib/work-summary'
import { modelLabel } from './lib/model'
import { ModelPicker } from './components/ModelPicker'
import { demoBots, demoMessages, demoRoutines, demoWork } from './lib/demo'
import { Sidebar } from './components/Sidebar'
import { ChatView } from './components/ChatView'
import { DetailsPanel } from './components/DetailsPanel'
import { Login, Logo } from './components/Login'
import { ServerRequestDialog } from './components/ServerRequestDialog'
import type { PendingImage } from './components/Composer'

const DEMO = new URLSearchParams(location.search).get('demo') === '1'

interface ChatCacheEntry {
  chat: ActiveChat
  messages: ChatMessage[]
  routines: Routine[]
}

function latestMessageTime(messages: ChatMessage[]) {
  return messages.reduce((latest, message) => Math.max(latest, message.createdAt ? Date.parse(message.createdAt) : 0), 0)
}

function preferredDark() {
  try {
    const saved = localStorage.getItem('hermesbot-theme')
    if (saved) return saved === 'dark'
  } catch { /* storage indisponible */ }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches || false
}

/** Bascule de thème en révélation circulaire depuis le bouton (View Transitions), instantanée sinon. */
function revealTheme(dark: boolean, apply: () => void, origin?: { x: number; y: number }) {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
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
  const workRef = useRef(new Map<string, WorkSummary>())
  const workSeqRef = useRef(new Map<string, number>())
  const [workSummaries, setWorkSummaries] = useState<Record<string, WorkSummary>>(DEMO ? demoWork : {})
  const [detailsOpen, setDetailsOpen] = useState(() => window.innerWidth >= 1180)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [dark, setDark] = useState(preferredDark)
  const [focusSignal, setFocusSignal] = useState(0)
  const [notice, setNotice] = useState('')
  const [chatModel, setChatModel] = useState('')
  const [usage, setUsage] = useState<SessionUsage | null>(null)
  const [showUsage, setShowUsage] = useState(() => {
    try { return localStorage.getItem('hermesbot-show-usage') === '1' } catch { return false }
  })
  const [modelQuery, setModelQuery] = useState<string | null>(null)
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState('')

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

  useEffect(() => {
    selectedRef.current = selected
  }, [selected])

  useEffect(() => {
    botsRef.current = bots
  }, [bots])

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
    try { localStorage.setItem('hermesbot-theme', dark ? 'dark' : 'light') } catch { /* storage indisponible */ }
  }, [dark])

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
      const workOwner = isCurrent && current ? current.profile : event.session_id ? botsRef.current.find((bot) => bot.sessionId === event.session_id)?.slug : undefined
      if (workOwner) applyWork(workOwner, event)
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
        const next = parseUsage(payload.usage)
        if (next) setUsage(next)
      }
      if (event.type === 'message.start') {
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
        if (finalUsage) setUsage(finalUsage)
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
    const timer = setInterval(() => {
      if (document.hidden) return
      loadRoster(client).then((roster) => {
        setBots((current) => mergeRoster(current, roster.bots, selectedRef.current, (slug) => chatCacheRef.current.get(slug)?.chat.running === true))
      }).catch(() => { /* la connexion est signalée par le pied de la sidebar */ })
    }, 30_000)
    return () => clearInterval(timer)
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
    try { localStorage.setItem('hermesbot-show-usage', showUsage ? '1' : '0') } catch { /* storage indisponible */ }
    const chat = activeChatRef.current
    if (!showUsage || !chat || DEMO) return
    loadUsage(client, chat).then((next) => {
      if (activeChatRef.current?.sessionId === chat.sessionId) setUsage(next)
    }).catch(() => setUsage(null))
  }, [showUsage, selected, chatLoading, client])

  const initialize = async () => {
    setAuthError('')
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
    }
  }

  useEffect(() => {
    if (DEMO || initializedRef.current) return
    initializedRef.current = true
    fetch('/api/auth/me', { credentials: 'same-origin' }).then(async (response) => {
      if (response.status === 401) setAuth('login')
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

  const login = async (username: string, password: string) => {
    setAuthError('')
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'basic', username, password }),
    })
    if (!response.ok) {
      setAuthError(response.status === 401 ? 'Identifiant ou mot de passe incorrect.' : 'La gateway refuse la connexion.')
      return
    }
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
        if (chatResult.value.chat.running) updateBot(profile, { status: 'working' })
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
      const session = await fetch('/api/auth/me', { credentials: 'same-origin' })
      if (session.status === 401) {
        client.close()
        setConnected(false)
        setNotice('Session Hermes expirée : reconnecte-toi.')
        setAuth('login')
        return
      }
      if (!session.ok) throw new Error('gateway_indisponible')
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
      setNotice('Hermes ne répond pas. Si le tunnel SSH est tombé, relance l’app.')
    } finally {
      reconnectingRef.current = false
      setReconnecting(false)
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

  const attachImage = async (chat: ActiveChat, image: PendingImage) => {
    const [header, data] = image.dataUrl.split(',')
    const mime = header.match(/data:([^;]+)/)?.[1] || 'image/png'
    const result = await client.request('image.attach_bytes', {
      profile: chat.profile,
      session_id: chat.sessionId,
      content_base64: data,
      filename: image.name,
    })
    return { path: result.path, mime: result.mime || mime }
  }

  const send = async (text: string, images: PendingImage[]) => {
    const now = new Date().toISOString()
    if (DEMO) {
      setMessages((items) => [...items,
        { id: `demo-user-${Date.now()}`, role: 'user', content: text, createdAt: now },
        { id: `demo-answer-${Date.now()}`, role: 'assistant', content: 'Mode démo visuel : connecte-toi à Hermes pour recevoir une vraie réponse.', createdAt: new Date().toISOString() },
      ])
      return
    }
    let chat = activeChatRef.current
    if (!chat || chat.profile !== selected || running) return
    // Un socket neuf n’est abonné à rien : sans reprise, prompt.submit répond permission_denied.
    try {
      await client.connect()
      if (chat.socketGeneration !== client.generation) {
        chat = (await openChat(client, chat.profile, chat.sessionId)).chat
        activeChatRef.current = chat
        updateCachedChat(chat.profile, chat)
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Connexion à Hermes impossible.')
      return
    }
    const content = [text, ...images.map((image) => `[Image : ${image.name}]`)].join('\n\n')
    clearDoneTimer(selected)
    const userMessage: ChatMessage = { id: `local-${Date.now()}`, role: 'user', content, createdAt: now }
    setMessages((items) => [...items, userMessage])
    appendCachedMessage(selected, userMessage)
    updateCachedChat(selected, { running: true })
    updateBot(selected, { preview: text, timestamp: now, status: 'working' })
    setRunning(true)
    setActivity('')
    try {
      const attachments = []
      for (const image of images) attachments.push(await attachImage(chat, image))
      await submitPrompt(client, chat, text, attachments)
      activeChatRef.current = { ...chat, running: true }
    } catch (error) {
      setRunning(false)
      updateCachedChat(selected, { running: false })
      updateBot(selected, { status: 'idle' })
      // Un mail approuvé dont l’envoi au bot échoue doit redevenir une carte à valider.
      const markFailed = (items: ChatMessage[]) => items.map((item) => item.id === userMessage.id ? { ...item, failed: true } : item)
      setMessages(markFailed)
      const cachedChat = chatCacheRef.current.get(selected)
      if (cachedChat) chatCacheRef.current.set(selected, { ...cachedChat, messages: markFailed(cachedChat.messages) })
      const message: ChatMessage = { id: `error-${Date.now()}`, role: 'system', content: 'Le message n’a pas été envoyé. Vérifie la connexion avant de réessayer.', createdAt: new Date().toISOString() }
      setMessages((items) => [...items, message])
      appendCachedMessage(selected, message)
      setNotice(error instanceof Error ? error.message : 'Échec de l’envoi.')
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

  const openModels = (query: string) => {
    setModelQuery(query)
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

  const selectedBot = bots.find((bot) => bot.slug === selected) || bots[0]
  const openRequest = serverRequests[0]

  if (auth === 'checking') {
    return <div className="app-loading"><Logo /><p>Ouverture de HermesBot…</p></div>
  }
  if (auth === 'login') return <Login onLogin={login} error={authError || notice} />
  if (!selectedBot) {
    return <div className="app-loading"><p>Aucun bot à afficher.</p>{notice && <p>{notice}</p>}<button className="connection-retry" disabled={reconnecting} onClick={reconnect}>{reconnecting ? 'Reconnexion…' : 'Reconnecter Hermes'}</button></div>
  }

  return (
    <div className="app-shell">
      <Sidebar
        bots={bots}
        selected={selectedBot.slug}
        connected={connected}
        reconnecting={reconnecting}
        onReconnect={reconnect}
        workSummaries={workSummaries}
        dark={dark}
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
        onSelect={selectBot}
        onNewMessage={() => { setFocusSignal((value) => value + 1); setMobileOpen(false) }}
        onToggleTheme={(origin) => revealTheme(!dark, () => setDark(!dark), origin)}
      />
      <ChatView
        bot={selectedBot}
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
        modelLabel={modelLabel(chatModel || selectedBot.model)}
        onOpenModels={openModels}
        usage={usage}
        showUsage={showUsage}
        onToggleUsage={() => setShowUsage((value) => !value)}
        modelPicker={modelQuery !== null ? (
          <ModelPicker
            options={modelOptions}
            current={chatModel || selectedBot.model}
            profileModel={selectedBot.model}
            loading={modelsLoading}
            error={modelsError}
            initialQuery={modelQuery}
            onSelect={selectModel}
            onClose={() => setModelQuery(null)}
          />
        ) : undefined}
      />
      {detailsOpen && <DetailsPanel bot={selectedBot} work={workSummaries[selectedBot.slug]} routines={routines} messages={messages} loading={routinesLoading} onClose={() => setDetailsOpen(false)} />}
      {openRequest && <ServerRequestDialog key={openRequest.id} request={openRequest} botName={bots.find((bot) => bot.sessionId === openRequest.params.session_id)?.name || selectedBot.name} onAnswer={answerServerRequest} />}
      {notice && <div className="toast" role="status"><AlertCircle size={17} /><span>{notice}</span><button aria-label="Fermer" onClick={() => setNotice('')}><X size={15} /></button></div>}
      {DEMO && <div className="demo-badge">Démo visuelle</div>}
    </div>
  )
}
