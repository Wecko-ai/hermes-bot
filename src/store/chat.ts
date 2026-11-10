import { create } from 'zustand'
import type { ChatMessage, Routine, SessionUsage } from '../types'
import type { ActiveChat } from '../lib/hermes'
import { resolveUpdater, type Updater } from './updater'

/** Ce qu’on garde d’un Bot Chat pour le rouvrir instantanément, avant la relecture serveur. */
export interface ChatCacheEntry {
  chat: ActiveChat
  messages: ChatMessage[]
  routines: Routine[]
}

export function latestMessageTime(messages: ChatMessage[]) {
  return messages.reduce((latest, message) => Math.max(latest, message.createdAt ? Date.parse(message.createdAt) : 0), 0)
}

/**
 * Messages à garder après une relecture serveur : jamais une copie serveur plus ancienne que le cache.
 * `preserveLive` : un tour est suivi en direct, le cache fait foi quoi que dise le serveur.
 */
export function resolveSyncedMessages(cached: ChatCacheEntry | undefined, server: ChatMessage[], preserveLive: boolean) {
  const newerCache = Boolean(cached) && latestMessageTime(cached!.messages) > latestMessageTime(server)
  return (preserveLive || newerCache) && cached ? cached.messages : server
}

/** Notes pas encore présentes dans la liste (par identifiant). */
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
   * Identifiant du tour en cours : la bulle de streaming et le message final le partagent,
   * React garde donc le même élément (une vidéo en lecture continue).
   */
  streamKey: string
  running: boolean
  activity: string
  usage: SessionUsage | null
  /** Un Bot Chat par profil. Table mutée en place (jamais lue pour le rendu) : on la lit via les actions. */
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
  /** Ajoute au cache les notes qui n’y sont pas déjà. */
  appendCachedNotes: (profile: string, notes: ChatMessage[]) => void
  markCachedFailed: (profile: string, messageId: string) => void
  /** Après une coupure : aucun tour du cache n’est plus suivi. */
  stopAllCachedRuns: () => void

  /** Retour à un bot depuis la liste : état du cache, ou vide avec chargement. N’efface pas le modèle ni l’usage. */
  showProfileFromList: (profile: string) => void
  /** Bot sélectionné (effet sur `selected`) : repart de zéro, puis reprend le cache s’il existe. */
  enterProfile: (profile: string) => void
  /** Relecture serveur terminée : cache, chat ouvert, messages et statut de tour. Ne touche ni routines ni chargement. */
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
  setChatModel: (value) => set((state) => ({ chatModel: resolveUpdater(value, state.chatModel) })),
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
  setCached: (profile, entry) => { get().cache.set(profile, entry) },
  updateCachedChat: (profile, changes) => {
    const { cache } = get()
    const cached = cache.get(profile)
    if (cached) cache.set(profile, { ...cached, chat: { ...cached.chat, ...changes } })
  },
  appendCachedMessage: (profile, message) => {
    const { cache } = get()
    const cached = cache.get(profile)
    if (cached) cache.set(profile, { ...cached, messages: [...cached.messages, message] })
  },
  appendCachedNotes: (profile, notes) => {
    const { cache } = get()
    const cached = cache.get(profile)
    if (cached) cache.set(profile, { ...cached, messages: [...cached.messages, ...freshNotes(cached.messages, notes)] })
  },
  markCachedFailed: (profile, messageId) => {
    const { cache } = get()
    const cached = cache.get(profile)
    if (cached) cache.set(profile, { ...cached, messages: markMessageFailed(cached.messages, messageId) })
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
        chatModel: cached.chat.model || '',
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
    get().cache.set(profile, synced)
    set({
      activeChat: synced.chat,
      chatModel: synced.chat.model || '',
      running: synced.chat.running,
      ...(preserveLive ? {} : { messages: synced.messages }),
      ...(!synced.chat.running && resumed ? { streaming: '', streamKey: '', activity: '' } : {}),
    })
  },
}))

/** Remise à zéro complète (tests). */
export function resetChatStore() {
  useChatStore.setState({
    activeChat: null, chatModel: '', messages: [], routines: [], routinesLoading: false, chatLoading: true,
    streaming: '', streamKey: '', running: false, activity: '', usage: null, cache: new Map(),
  })
}
