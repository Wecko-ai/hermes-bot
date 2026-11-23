import { create } from 'zustand'
import type { ChatMessage, Routine, SessionUsage } from '../types'
import type { ActiveChat } from '../lib/hermes'
import { pickerModelForSession } from '../lib/auto-router'
import { resolveUpdater, type Updater } from './updater'

/** What is kept of a Bot Chat to reopen it instantly, before the server re-read. */
export interface ChatCacheEntry {
  chat: ActiveChat
  messages: ChatMessage[]
  routines: Routine[]
  /** Model picker choice (may be `hermesbot:auto` while `chat.model` is a routed model). */
  pickerModel?: string
}

export function latestMessageTime(messages: ChatMessage[]) {
  return messages.reduce((latest, message) => Math.max(latest, message.createdAt ? Date.parse(message.createdAt) : 0), 0)
}

/** Cached and open transcripts keep this tail. The server remains the full history. */
export const CHAT_CACHE_LIMIT = 500

export function trimCachedMessages(messages: ChatMessage[]) {
  return messages.length > CHAT_CACHE_LIMIT ? messages.slice(-CHAT_CACHE_LIMIT) : messages
}

function normalizedText(text: unknown) {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
}

function textKey(message: ChatMessage) {
  return `${message.role}\u0000${normalizedText(message.content)}`
}

/**
 * Messages to keep after a server re-read.
 * The server transcript comes first, so tool rows and steps are never dropped.
 * A cached row matches a server row by id when both have one, otherwise by role
 * and normalized text. Cached rows with no match that sit after the last matched
 * cached row are appended: they are the live tail not persisted yet.
 * Clocks are not compared. `preserveLive` keeps the cached object for a row that
 * shares an id, so a turn on screen is not swapped for a different server body.
 * Linear time: server rows are indexed once (a long history has thousands of rows,
 * and this runs on the interface's thread while the chat opens).
 */
export function resolveSyncedMessages(cached: ChatCacheEntry | undefined, server: ChatMessage[], preserveLive: boolean) {
  if (!cached) return server
  const cacheRows = cached.messages
  const byId = new Map<string, number[]>()
  const byText = new Map<string, number[]>()
  const serverKeys = server.map(textKey)
  server.forEach((row, index) => {
    if (row.id) {
      const ids = byId.get(row.id)
      if (ids) ids.push(index)
      else byId.set(row.id, [index])
    }
    const key = serverKeys[index]
    const texts = byText.get(key)
    if (texts) texts.push(index)
    else byText.set(key, [index])
  })
  const used = new Set<number>()
  const cursors = new Map<number[], number>()
  /** First server index of `list` not taken yet. */
  const takeFirst = (list: number[] | undefined) => {
    if (!list) return -1
    let at = cursors.get(list) ?? 0
    while (at < list.length && used.has(list[at])) at += 1
    cursors.set(list, at)
    if (at >= list.length) return -1
    used.add(list[at])
    cursors.set(list, at + 1)
    return list[at]
  }
  const matchAt = cacheRows.map((row) => {
    const byIdIndex = row.id ? takeFirst(byId.get(row.id)) : -1
    if (byIdIndex >= 0) return byIdIndex
    return takeFirst(byText.get(textKey(row)))
  })
  let lastMatched = -1
  matchAt.forEach((serverIndex, index) => {
    if (serverIndex >= 0) lastMatched = index
  })
  const keepCacheBody = new Map<number, ChatMessage>()
  cacheRows.forEach((row, index) => {
    const serverIndex = matchAt[index]
    if (serverIndex < 0) return
    const serverRow = server[serverIndex]
    const sameId = Boolean(row.id && serverRow.id === row.id)
    const textDiffers = textKey(row) !== serverKeys[serverIndex]
    if (sameId && (textDiffers || preserveLive)) keepCacheBody.set(serverIndex, row)
  })
  const tail: ChatMessage[] = []
  cacheRows.forEach((row, index) => {
    if (index > lastMatched && matchAt[index] < 0) tail.push(row)
  })
  // A fallback stamp is not in the gateway transcript. Keep it when the server row replaces the cache body.
  const carried = new Map<number, ChatMessage>()
  cacheRows.forEach((row, index) => {
    const serverIndex = matchAt[index]
    if (serverIndex < 0 || !row.answeredBy || keepCacheBody.has(serverIndex)) return
    const serverRow = server[serverIndex]
    if (serverRow.answeredBy) return
    carried.set(serverIndex, { ...serverRow, answeredBy: row.answeredBy })
  })
  if (!tail.length && keepCacheBody.size === 0 && carried.size === 0) return server
  const merged = keepCacheBody.size === 0 && carried.size === 0
    ? server
    : server.map((row, index) => keepCacheBody.get(index) ?? carried.get(index) ?? row)
  return tail.length ? [...merged, ...tail] : merged
}

/** Notes not yet in the list (by identifier). */
export function freshNotes(items: ChatMessage[], notes: ChatMessage[]) {
  return notes.filter((note) => !items.some((item) => item.id === note.id))
}

export function markMessageFailed(items: ChatMessage[], id: string) {
  return items.map((item) => item.id === id ? { ...item, failed: true } : item)
}

export interface SyncedChat {
  chat: ActiveChat
  messages: ChatMessage[]
  routines: Routine[]
}

export interface ChatState {
  activeChat: ActiveChat | null
  chatModel: string
  messages: ChatMessage[]
  routines: Routine[]
  routinesLoading: boolean
  chatLoading: boolean
  streaming: string
  /**
   * Identifier of the current turn: the streaming bubble and the final message share it,
   * so React keeps the same element (a playing video keeps playing).
   */
  streamKey: string
  running: boolean
  activity: string
  usage: SessionUsage | null
  /** One Bot Chat per profile. Table mutated in place (never read for rendering): read it through the actions. */
  cache: Map<string, ChatCacheEntry>

  setActiveChat: (chat: ActiveChat | null) => void
  setChatModel: (value: Updater<string>) => void
  setMessages: (value: Updater<ChatMessage[]>) => void
  setRoutines: (routines: Routine[]) => void
  setRoutinesLoading: (value: boolean) => void
  setChatLoading: (value: boolean) => void
  setStreaming: (value: Updater<string>) => void
  setStreamKey: (value: string) => void
  setRunning: (value: boolean) => void
  setActivity: (value: string) => void
  setUsage: (value: Updater<SessionUsage | null>) => void

  getCached: (profile: string) => ChatCacheEntry | undefined
  setCached: (profile: string, entry: ChatCacheEntry) => void
  updateCachedChat: (profile: string, changes: Partial<ActiveChat>) => void
  appendCachedMessage: (profile: string, message: ChatMessage) => void
  /** Adds to the cache the notes that are not already there. */
  appendCachedNotes: (profile: string, notes: ChatMessage[]) => void
  markCachedFailed: (profile: string, messageId: string) => void
  /** Changes one cached message (e.g. the images of a sent message once uploaded). */
  patchCachedMessage: (profile: string, messageId: string, changes: Partial<ChatMessage>) => void
  /** After a disconnection: no cached turn is followed any more. */
  stopAllCachedRuns: () => void

  /** Back to a bot from the list: cached state, or empty with loading. Does not clear the model or the usage. */
  showProfileFromList: (profile: string) => void
  /** Bot selected (effect on `selected`): starts from scratch, then takes the cache if there is one. */
  enterProfile: (profile: string) => void
  /** Server re-read finished: cache, open chat, messages and turn status. Touches neither routines nor loading. */
  applySyncedChat: (profile: string, synced: SyncedChat, options: { preserveLive: boolean; resumed: boolean }) => void
}

export const useChatStore = create<ChatState>()((set, get) => ({
  activeChat: null,
  chatModel: '',
  messages: [],
  routines: [],
  routinesLoading: false,
  chatLoading: true,
  streaming: '',
  streamKey: '',
  running: false,
  activity: '',
  usage: null,
  cache: new Map(),

  setActiveChat: (activeChat) => set({ activeChat }),
  setChatModel: (value) => {
    const chatModel = resolveUpdater(value, get().chatModel)
    const profile = get().activeChat?.profile
    if (profile) {
      const cached = get().cache.get(profile)
      if (cached) get().cache.set(profile, { ...cached, pickerModel: chatModel })
    }
    set({ chatModel })
  },
  // The open thread keeps its whole history (the user scrolls it); only stored cache entries are capped.
  setMessages: (value) => set((state) => ({ messages: resolveUpdater(value, state.messages) })),
  setRoutines: (routines) => set({ routines }),
  setRoutinesLoading: (routinesLoading) => set({ routinesLoading }),
  setChatLoading: (chatLoading) => set({ chatLoading }),
  setStreaming: (value) => set((state) => ({ streaming: resolveUpdater(value, state.streaming) })),
  setStreamKey: (streamKey) => set({ streamKey }),
  setRunning: (running) => set({ running }),
  setActivity: (activity) => set({ activity }),
  setUsage: (value) => set((state) => ({ usage: resolveUpdater(value, state.usage) })),

  getCached: (profile) => get().cache.get(profile),
  setCached: (profile, entry) => {
    const messages = trimCachedMessages(entry.messages)
    get().cache.set(profile, messages === entry.messages ? entry : { ...entry, messages })
  },
  updateCachedChat: (profile, changes) => {
    const { cache } = get()
    const cached = cache.get(profile)
    if (cached) cache.set(profile, { ...cached, chat: { ...cached.chat, ...changes } })
  },
  appendCachedMessage: (profile, message) => {
    const { cache } = get()
    const cached = cache.get(profile)
    if (cached) cache.set(profile, { ...cached, messages: trimCachedMessages([...cached.messages, message]) })
  },
  appendCachedNotes: (profile, notes) => {
    const { cache } = get()
    const cached = cache.get(profile)
    if (cached) cache.set(profile, { ...cached, messages: trimCachedMessages([...cached.messages, ...freshNotes(cached.messages, notes)]) })
  },
  markCachedFailed: (profile, messageId) => {
    const { cache } = get()
    const cached = cache.get(profile)
    if (cached) cache.set(profile, { ...cached, messages: markMessageFailed(cached.messages, messageId) })
  },
  patchCachedMessage: (profile, messageId, changes) => {
    const { cache } = get()
    const cached = cache.get(profile)
    if (cached) cache.set(profile, { ...cached, messages: cached.messages.map((item) => item.id === messageId ? { ...item, ...changes } : item) })
  },
  stopAllCachedRuns: () => {
    const { cache, updateCachedChat } = get()
    cache.forEach((entry, slug) => {
      if (entry.chat.running) updateCachedChat(slug, { running: false })
    })
  },

  showProfileFromList: (profile) => {
    const cached = get().cache.get(profile)
    set({
      activeChat: cached?.chat || null,
      chatLoading: !cached,
      routinesLoading: !cached,
      messages: cached?.messages || [],
      routines: cached?.routines || [],
      streaming: '',
      streamKey: '',
      activity: '',
      running: cached?.chat.running || false,
    })
  },
  enterProfile: (profile) => {
    const cached = get().cache.get(profile)
    set({ streaming: '', streamKey: '', activity: '', usage: null })
    if (cached) {
      set({
        activeChat: cached.chat,
        chatModel: pickerModelForSession(cached.pickerModel, cached.chat.model),
        messages: cached.messages,
        routines: cached.routines,
        running: cached.chat.running,
        chatLoading: false,
        routinesLoading: false,
      })
    } else {
      set({
        activeChat: null,
        chatModel: '',
        messages: [],
        routines: [],
        running: false,
        chatLoading: true,
        routinesLoading: true,
      })
    }
  },
  applySyncedChat: (profile, synced, { preserveLive, resumed }) => {
    const messages = trimCachedMessages(synced.messages)
    const stored = messages === synced.messages ? synced : { ...synced, messages }
    const prev = get().cache.get(profile)
    const pickerModel = prev?.pickerModel
    get().cache.set(profile, { ...stored, ...(pickerModel ? { pickerModel } : {}) })
    set({
      activeChat: synced.chat,
      chatModel: pickerModelForSession(pickerModel, synced.chat.model),
      running: synced.chat.running,
      ...(preserveLive ? {} : { messages: synced.messages }),
      ...(!synced.chat.running && resumed ? { streaming: '', streamKey: '', activity: '' } : {}),
    })
  },
}))

/** Full reset (tests). */
export function resetChatStore() {
  useChatStore.setState({
    activeChat: null, chatModel: '', messages: [], routines: [], routinesLoading: false, chatLoading: true,
    streaming: '', streamKey: '', running: false, activity: '', usage: null, cache: new Map(),
  })
}
