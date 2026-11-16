/**
 * Saved conversations of the isolated local chat (Ollama). In the macOS app, the store is a file encrypted with
 * `safeStorage` (electron/main.cjs): `load()` returns `null` when there is no file yet and throws when the file
 * cannot be read. An unreadable store is never overwritten: saving is refused until it reads again.
 * Without a store (browser mode), conversations last as long as the server.
 */

const CONVERSATION_ID = /^[A-Za-z0-9_-]{8,64}$/
const MESSAGE_ID = /^[A-Za-z0-9_.:-]{1,100}$/
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/
const MAX_MESSAGES = 400
const TITLE_LENGTH = 80

export const LOCAL_HISTORY_LIMITS = {
  conversations: 500,
  conversationBytes: 4 * 1024 * 1024,
  storeBytes: 64 * 1024 * 1024,
}

const isoDate = (value, fallback) => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : fallback)

/** The first line of the first message from the user, cut to a title. */
export function conversationTitle(messages) {
  const first = messages.find((message) => message.role === 'user')?.content || ''
  const line = first.trim().split('\n')[0].replace(/\s+/g, ' ')
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1).trimEnd()}…` : line
}

/** Only the known fields of the messages, or `null` if one is not a message of the local chat. */
export function cleanMessages(value, now = new Date().toISOString()) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MESSAGES) return null
  const messages = value.map((message) => ({
    id: typeof message?.id === 'string' && MESSAGE_ID.test(message.id) ? message.id : '',
    role: message?.role,
    content: message?.content,
    createdAt: isoDate(message?.createdAt, now),
  }))
  const valid = messages.every(({ id, role, content }) => id && (role === 'user' || role === 'assistant') && typeof content === 'string' && content)
  return valid ? messages : null
}

function readStore(store) {
  if (!store) return { conversations: new Map(), readable: true }
  let text
  try {
    text = store.load()
  } catch {
    return { conversations: new Map(), readable: false }
  }
  if (text === null || text === undefined || text === '') return { conversations: new Map(), readable: true }
  try {
    const body = JSON.parse(text)
    const conversations = new Map()
    for (const entry of Array.isArray(body?.conversations) ? body.conversations : []) {
      const messages = cleanMessages(entry?.messages)
      if (!CONVERSATION_ID.test(entry?.id || '') || !messages) continue
      const updatedAt = isoDate(entry.updatedAt, new Date(0).toISOString())
      conversations.set(entry.id, {
        id: entry.id,
        model: typeof entry.model === 'string' && MODEL.test(entry.model) ? entry.model : '',
        createdAt: isoDate(entry.createdAt, updatedAt),
        updatedAt,
        messages,
      })
    }
    return { conversations, readable: true }
  } catch {
    return { conversations: new Map(), readable: false }
  }
}

export function createLocalChatHistory(store, limits = LOCAL_HISTORY_LIMITS) {
  let state = null
  const current = () => {
    // An unreadable store is read again at each call: the Keychain may only have been locked for a moment.
    if (!state || !state.readable) state = readStore(store)
    return state
  }
  const write = (conversations) => {
    const text = JSON.stringify({ version: 1, conversations: [...conversations.values()] })
    if (Buffer.byteLength(text) > limits.storeBytes) return 'history_full'
    if (store) {
      try {
        store.save(text)
      } catch {
        return 'history_unwritable'
      }
    }
    state = { conversations, readable: true }
    return ''
  }

  return {
    persistent: Boolean(store),
    /** Summaries, the most recent first. `readable: false`: the store exists but cannot be read now. */
    list() {
      const { conversations, readable } = current()
      const items = [...conversations.values()]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(({ id, model, createdAt, updatedAt, messages }) => ({ id, title: conversationTitle(messages), model, createdAt, updatedAt, count: messages.length }))
      return { readable, conversations: items }
    },
    get(id) {
      const { conversations } = current()
      const conversation = CONVERSATION_ID.test(id) ? conversations.get(id) : undefined
      return conversation ? { ...conversation, title: conversationTitle(conversation.messages) } : null
    },
    /** Creates or replaces a conversation. Returns an error code, or `''`. */
    save(id, body, now = new Date().toISOString()) {
      if (!CONVERSATION_ID.test(id || '')) return 'invalid_conversation'
      const messages = cleanMessages(body?.messages, now)
      if (!messages) return 'invalid_messages'
      const model = typeof body?.model === 'string' && MODEL.test(body.model) ? body.model : ''
      const { conversations, readable } = current()
      if (!readable) return 'history_unreadable'
      const previous = conversations.get(id)
      if (!previous && conversations.size >= limits.conversations) return 'history_full'
      const conversation = { id, model, createdAt: previous?.createdAt || now, updatedAt: now, messages }
      if (Buffer.byteLength(JSON.stringify(conversation)) > limits.conversationBytes) return 'conversation_too_large'
      const next = new Map(conversations)
      next.delete(id)
      next.set(id, conversation)
      return write(next)
    },
    remove(id) {
      if (!CONVERSATION_ID.test(id || '')) return 'invalid_conversation'
      const { conversations, readable } = current()
      if (!readable) return 'history_unreadable'
      if (!conversations.has(id)) return ''
      const next = new Map(conversations)
      next.delete(id)
      return write(next)
    },
  }
}
