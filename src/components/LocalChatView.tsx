import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, MemoryStick, Menu, RotateCcw } from 'lucide-react'
import type { Bot, ChatMessage } from '../types'
import { formatBytes, loadLocalMemory, setLocalModelLoaded, streamLocalChat, visibleAnswer, type LocalMemory, type LocalModels } from '../lib/local-chat'
import { updateSettings } from '../lib/settings'
import { LiveAvatar } from './LiveAvatar'
import { LocalModelMenu } from './LocalModelMenu'
import { MessageList } from './MessageList'
import { Composer } from './Composer'
import { i18n } from '../i18n'

interface LocalChatViewProps {
  bot: Bot
  active: boolean
  focusSignal: number
  onOpenMobile: () => void
  onNotice: (text: string) => void
  onRunningChange: (running: boolean) => void
  /** Installed models, for the model menu. */
  models: LocalModels | null
  /** Reads the installed models again (the menu opens). */
  onRefreshModels: () => void
  /** Visual demo: a fictional conversation, and a fixed reply instead of the model. Nothing is fetched. */
  demo?: { messages: ChatMessage[]; answer: string }
}

const noop = () => undefined
// Ollama’s memory, read again while the local chat is on screen.
const MEMORY_POLL_MS = 15_000

/** `15:02`. Nothing when Ollama keeps the model with no end (more than a day). */
function unloadTime(expiresAt: string) {
  const at = Date.parse(expiresAt)
  if (!Number.isFinite(at) || at < Date.now() || at - Date.now() > 24 * 60 * 60_000) return ''
  return new Intl.DateTimeFormat(i18n.language, { hour: '2-digit', minute: '2-digit' }).format(at)
}

/** Direct conversation with the local model. Stays mounted while another bot is on screen. */
export function LocalChatView({ bot, active, focusSignal, onOpenMobile, onNotice, onRunningChange, models, onRefreshModels, demo }: LocalChatViewProps) {
  const { t } = useTranslation()
  const [messages, setMessages] = useState<ChatMessage[]>(() => demo?.messages ?? [])
  const messagesRef = useRef<ChatMessage[]>(demo?.messages ?? [])
  const [streaming, setStreaming] = useState('')
  const [streamKey, setStreamKey] = useState('')
  const [running, setRunningState] = useState(false)
  const [activity, setActivity] = useState('')
  const controllerRef = useRef<AbortController | null>(null)
  useEffect(() => () => controllerRef.current?.abort(), [])
  const [memory, setMemory] = useState<LocalMemory | null>(null)
  const [memoryAction, setMemoryAction] = useState<'' | 'load' | 'unload'>('')
  const memoryRequest = useRef(0)
  const refreshMemory = useCallback(async () => {
    if (demo) return
    const request = ++memoryRequest.current
    const next = await loadLocalMemory()
    // A slower, older read must not replace a newer one.
    if (request === memoryRequest.current) setMemory(next)
  }, [demo])
  useEffect(() => {
    if (!active || demo) return
    void refreshMemory()
    const timer = window.setInterval(() => { if (!document.hidden) void refreshMemory() }, MEMORY_POLL_MS)
    return () => window.clearInterval(timer)
  }, [active, demo, refreshMemory])
  // After a reply, Ollama has the model in memory: show it without waiting for the next read.
  useEffect(() => { if (!running) void refreshMemory() }, [running, refreshMemory])
  const loaded = memory?.loaded.find((entry) => entry.model === bot.model)

  const toggleMemory = async () => {
    if (memoryAction || demo) return
    const load = !loaded
    setMemoryAction(load ? 'load' : 'unload')
    try {
      await setLocalModelLoaded(bot.model, load)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : i18n.t(load ? 'localChat.loadFailed' : 'localChat.unloadFailed'))
    }
    await refreshMemory()
    setMemoryAction('')
  }
  const chooseModel = (model: string) => {
    updateSettings({ localModel: model })
  }

  const setRunning = (value: boolean) => {
    setRunningState(value)
    onRunningChange(value)
  }
  const commit = (next: ChatMessage[]) => {
    messagesRef.current = next
    setMessages(next)
  }

  const send = async (text: string) => {
    if (running) return false
    const history = [...messagesRef.current, { id: `local-${Date.now()}`, role: 'user', content: text, createdAt: new Date().toISOString() } satisfies ChatMessage]
    commit(history)
    if (demo) {
      commit([...history, { id: `local-answer-${Date.now()}`, role: 'assistant', content: demo.answer, createdAt: new Date().toISOString() }])
      return true
    }
    const key = `local-answer-${Date.now()}`
    const controller = new AbortController()
    controllerRef.current = controller
    setStreamKey(key)
    setRunning(true)
    setActivity(i18n.t('localChat.loadingModel'))
    let raw = ''
    try {
      await streamLocalChat(bot.model, history.map(({ role, content }) => ({ role, content })), (frame) => {
        if (frame.thinking) setActivity(i18n.t('localChat.thinking'))
        if (!frame.content) return
        raw += frame.content
        const shown = visibleAnswer(raw)
        if (shown) setActivity('')
        else setActivity(i18n.t('localChat.thinking'))
        setStreaming(shown)
      }, controller.signal)
    } catch (error) {
      if (!controller.signal.aborted) onNotice(error instanceof Error ? error.message : i18n.t('localChat.failed'))
    }
    const answer = visibleAnswer(raw).trim()
    if (answer) commit([...messagesRef.current, { id: key, role: 'assistant', content: answer, createdAt: new Date().toISOString() }])
    setStreaming('')
    setStreamKey('')
    setActivity('')
    setRunning(false)
    return true
  }

  const stop = () => controllerRef.current?.abort()
  const reset = () => {
    stop()
    commit([])
  }
  const suggestion = useCallback((text: string) => { void send(text) }, [running])
  const until = loaded ? unloadTime(loaded.expiresAt) : ''
  const size = loaded ? formatBytes(loaded.size) : ''
  const status = running ? t('localChat.replying')
    : memoryAction === 'load' ? t('localChat.loadingModel')
      : memoryAction === 'unload' ? t('localChat.unloadingModel')
        : loaded ? (until ? t('localChat.inMemoryUntil', { size, time: until }) : size ? t('localChat.inMemorySize', { size }) : t('localChat.inMemory'))
          : memory?.available ? t('localChat.notInMemory')
            : t('localChat.subtitle')

  return (
    <main className="chat-panel local-chat" hidden={!active}>
      <header className="chat-header">
        <div className="chat-leading"><button className="plain-icon mobile-menu" aria-label={t('chat.showBots')} onClick={onOpenMobile}><Menu size={19} /></button></div>
        <div className={`chat-identity ${running || memoryAction ? 'is-working' : loaded ? 'is-done' : 'is-idle'}`} title={bot.role}>
          <LiveAvatar bot={bot} size={26} />
          <div>
            <h1>{bot.name}</h1>
            <p className="chat-status"><span className="chat-status-dot" aria-hidden="true" /><span aria-live="polite">{status}</span></p>
          </div>
        </div>
        <div className="chat-header-actions">
          <LocalModelMenu current={bot.model} models={models} memory={memory} disabled={running || !!memoryAction} onOpen={() => { onRefreshModels(); void refreshMemory() }} onSelect={chooseModel} />
          {memory?.available && (
            <button type="button" className={`local-memory-button ${loaded ? 'is-loaded' : ''}`} title={t(loaded ? 'localChat.unloadHint' : 'localChat.loadHint', { model: bot.model })} disabled={!!memoryAction || (running && !!loaded)} onClick={() => void toggleMemory()}>
              {memoryAction ? <Loader2 size={14} className="is-spinning" aria-hidden="true" /> : <MemoryStick size={14} aria-hidden="true" />}
              <span>{t(loaded ? 'localChat.unload' : 'localChat.load')}</span>
            </button>
          )}
          <button className="plain-icon" aria-label={t('localChat.clear')} disabled={!messages.length && !running} onClick={reset}><RotateCcw size={16} /></button>
        </div>
      </header>
      <MessageList bot={bot} bots={[]} messages={messages} streaming={streaming} streamKey={streamKey} running={running} activity={activity} workText="" streamReply loading={false} onSuggestion={suggestion} onOpenDocument={noop} onOpenBot={noop} />
      <Composer minimal bot={bot} bots={[]} running={running} disabled={false} focusSignal={focusSignal} onSend={send} onStop={stop} onNotice={onNotice} modelLabel="" onOpenModels={noop} usage={null} showUsage={false} onToggleUsage={noop} />
    </main>
  )
}
