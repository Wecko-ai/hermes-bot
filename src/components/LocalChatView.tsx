import { useCallback, useEffect, useRef, useState } from 'react'
import { Menu, RotateCcw } from 'lucide-react'
import type { Bot, ChatMessage } from '../types'
import { streamLocalChat, visibleAnswer } from '../lib/local-chat'
import { LiveAvatar } from './LiveAvatar'
import { MessageList } from './MessageList'
import { Composer } from './Composer'

interface LocalChatViewProps {
  bot: Bot
  active: boolean
  focusSignal: number
  onOpenMobile: () => void
  onNotice: (text: string) => void
  onRunningChange: (running: boolean) => void
}

const noop = () => undefined

/** Conversation directe avec le modèle local. Reste montée pendant qu’on regarde un autre bot. */
export function LocalChatView({ bot, active, focusSignal, onOpenMobile, onNotice, onRunningChange }: LocalChatViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const messagesRef = useRef<ChatMessage[]>([])
  const [streaming, setStreaming] = useState('')
  const [streamKey, setStreamKey] = useState('')
  const [running, setRunningState] = useState(false)
  const [activity, setActivity] = useState('')
  const controllerRef = useRef<AbortController | null>(null)
  useEffect(() => () => controllerRef.current?.abort(), [])

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
    const key = `local-answer-${Date.now()}`
    const controller = new AbortController()
    controllerRef.current = controller
    setStreamKey(key)
    setRunning(true)
    setActivity('Chargement du modèle…')
    let raw = ''
    try {
      await streamLocalChat(history.map(({ role, content }) => ({ role, content })), (frame) => {
        if (frame.thinking) setActivity('Réfléchit…')
        if (!frame.content) return
        raw += frame.content
        const shown = visibleAnswer(raw)
        if (shown) setActivity('')
        else setActivity('Réfléchit…')
        setStreaming(shown)
      }, controller.signal)
    } catch (error) {
      if (!controller.signal.aborted) onNotice(error instanceof Error ? error.message : 'Le modèle local a échoué.')
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

  return (
    <main className="chat-panel local-chat" hidden={!active}>
      <header className="chat-header">
        <div className="chat-leading"><button className="plain-icon mobile-menu" aria-label="Afficher les bots" onClick={onOpenMobile}><Menu size={19} /></button></div>
        <div className="chat-identity is-idle" title={bot.role}>
          <LiveAvatar bot={bot} size={26} />
          <div>
            <h1>{bot.name}</h1>
            <p className="chat-status"><span className="chat-status-dot" aria-hidden="true" /><span aria-live="polite">{running ? 'Répond' : 'Local, sans outils'}</span></p>
          </div>
        </div>
        <div className="chat-header-actions">
          <button className="plain-icon" aria-label="Effacer la conversation locale" disabled={!messages.length && !running} onClick={reset}><RotateCcw size={16} /></button>
        </div>
      </header>
      <MessageList bot={bot} bots={[]} messages={messages} streaming={streaming} streamKey={streamKey} running={running} activity={activity} loading={false} onSuggestion={suggestion} onOpenDocument={noop} onOpenBot={noop} />
      <Composer minimal bot={bot} bots={[]} running={running} disabled={false} focusSignal={focusSignal} onSend={send} onStop={stop} onNotice={onNotice} modelLabel="" onOpenModels={noop} usage={null} showUsage={false} onToggleUsage={noop} />
    </main>
  )
}
