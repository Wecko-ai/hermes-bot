import type { ChatMessage } from '../types'
import { useChatStore, useRosterStore } from '../store'
import { submitPrompt, type ActiveChat, type HermesClient } from './hermes'
import { BOT_KICKOFF_TEXT, kickoffApiText } from './bot-kickoff'
import { demoIntroduction, type DemoLanguage } from './demo'

/** Sends the kickoff turn. The app passes the same routed submit a composer send uses. */
export type KickoffTurnSubmit = (input: {
  chat: ActiveChat
  text: string
  apiText: string
  message: ChatMessage
}) => Promise<ActiveChat>

/** A bot just created here, until its chat opens. `kickoff`: it then introduces itself, once. */
export interface FreshBot {
  slug: string
  title: string
  kickoff: boolean
  /** Failed tries at opening its chat so far. */
  attempts: number
}

/** Something already happened in this chat (another app wrote first, a turn runs): the bot does not introduce itself. */
export const chatHasStarted = (chat: ActiveChat, history: ChatMessage[]) =>
  chat.running || history.some((message) => !message.technical && (message.role === 'user' || message.role === 'assistant'))

/**
 * The first turn of a bot created here, as soon as its chat opens: it introduces itself and asks for its role.
 * The kickoff sentence stays out of the thread (Activity only) and the model reads the instruction in `api_text`;
 * no work mode and no caveman note. `submit`, when given, sends that turn (Auto routing included).
 * Without it, the prompt goes straight to Hermes. Resolves false when nothing was sent; `onFailed` gets a refused send.
 */
export async function kickOffNewBot(
  client: { request: (method: string, params?: Record<string, unknown>) => Promise<any> },
  opened: { chat: ActiveChat; messages: ChatMessage[] },
  fresh: FreshBot,
  language: DemoLanguage,
  onFailed: (message: ChatMessage, error: unknown) => void,
  submit?: KickoffTurnSubmit,
): Promise<boolean> {
  const { chat } = opened
  if (!fresh.kickoff || chatHasStarted(chat, opened.messages)) return false
  const chatStore = useChatStore.getState()
  const roster = useRosterStore.getState()
  const message: ChatMessage = { id: `kickoff-${Date.now()}`, role: 'user', content: BOT_KICKOFF_TEXT, createdAt: new Date().toISOString(), technical: true }
  const shown = () => useChatStore.getState().activeChat?.sessionId === chat.sessionId
  if (shown()) {
    chatStore.setMessages((items) => [...items, message])
    chatStore.setRunning(true)
    chatStore.setActivity('')
  }
  chatStore.appendCachedMessage(chat.profile, message)
  chatStore.updateCachedChat(chat.profile, { running: true })
  roster.clearDoneTimer(chat.profile)
  roster.updateBot(chat.profile, { status: 'working' })
  try {
    // As Hermes Desktop: the Bot Chat holds its title before its first turn, so no later open makes a second one.
    await client.request('session.title', { profile: chat.profile, session_id: chat.sessionId, title: 'Bot Chat' }).catch(() => undefined)
    const apiText = kickoffApiText({ title: fresh.title, slug: fresh.slug, language })
    // `submit` is the composer's routed send. Without it, `submitPrompt` only needs the client's `request`.
    const active = submit
      ? await submit({ chat, text: BOT_KICKOFF_TEXT, apiText, message })
      : await submitPrompt(client as HermesClient, chat, BOT_KICKOFF_TEXT, [], { apiText }).then(() => chat)
    if (shown()) {
      const open = useChatStore.getState().activeChat
      chatStore.setActiveChat(open?.sessionId === active.sessionId ? { ...open, ...active, running: true } : { ...active, running: true })
    }
    chatStore.updateCachedChat(chat.profile, { ...active, running: true })
    return true
  } catch (error) {
    if (shown()) {
      chatStore.setRunning(false)
      chatStore.setActivity('')
    }
    chatStore.updateCachedChat(chat.profile, { running: false })
    roster.updateBot(chat.profile, { status: 'idle' })
    onFailed(message, error)
    return false
  }
}

/** Demo: a bot just created starts empty, works a moment, then introduces itself. Nothing goes to Hermes. */
export function introduceDemoBot(slug: string, name: string, language: DemoLanguage, delayMs = 2_400) {
  const chatStore = useChatStore.getState()
  chatStore.setMessages([])
  chatStore.setRoutines([])
  chatStore.setRunning(true)
  useRosterStore.getState().updateBot(slug, { status: 'working' })
  return setTimeout(() => {
    const content = demoIntroduction(name, language)
    const now = new Date().toISOString()
    useRosterStore.getState().updateBot(slug, { preview: content, timestamp: now })
    useRosterStore.getState().markDone(slug)
    if (useRosterStore.getState().selected !== slug) return
    useChatStore.getState().setMessages((items) => [...items, { id: `demo-intro-${Date.now()}`, role: 'assistant', content, createdAt: now }])
    useChatStore.getState().setRunning(false)
  }, delayMs)
}
