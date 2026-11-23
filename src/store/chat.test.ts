import { beforeEach, describe, expect, it } from 'vitest'
import type { ChatMessage } from '../types'
import type { ActiveChat } from '../lib/hermes'
import { AUTO_FREE_MODEL_SENTINEL, AUTO_MODEL_SENTINEL } from '../lib/auto-router'
import { CHAT_CACHE_LIMIT, freshNotes, latestMessageTime, markMessageFailed, resetChatStore, resolveSyncedMessages, trimCachedMessages, useChatStore, type ChatCacheEntry } from './chat'

const message = (id: string, createdAt: string | null = null, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: 'assistant', content: id, createdAt, ...extra })
const chat = (profile: string, extra: Partial<ActiveChat> = {}): ActiveChat => ({
  profile, sessionId: `${profile}-s`, revision: 1, executionGeneration: 1, running: false, socketGeneration: 1, ...extra,
})
const entry = (profile: string, messages: ChatMessage[], extra: Partial<ActiveChat> = {}): ChatCacheEntry => ({ chat: chat(profile, extra), messages, routines: [] })

const T1 = '2026-11-10T10:00:00.000Z'
const T2 = '2026-11-10T10:05:00.000Z'

describe('fusion du cache de chat', () => {
  beforeEach(resetChatStore)

  it('lit la date du message le plus récent, 0 sans date', () => {
    expect(latestMessageTime([])).toBe(0)
    expect(latestMessageTime([message('a', T1), message('b', T2), message('c')])).toBe(Date.parse(T2))
  })

  it('ne remplace jamais un message récent du cache par une copie serveur plus ancienne', () => {
    const cached = entry('a', [message('old', T1), message('new', T2)])
    const serverRow = message('old', T1)
    const merged = resolveSyncedMessages(cached, [serverRow], false)
    expect(merged.map((item) => item.id)).toEqual(['old', 'new'])
    expect(merged[0]).toBe(serverRow)
    expect(merged[1]).toBe(cached.messages[1])
  })

  it('prend la copie serveur quand le cache n’a rien de plus récent que ce qu’elle contient', () => {
    const cached = entry('a', [message('old', T1)])
    const server = [message('old', T1), message('new', T2)]
    expect(resolveSyncedMessages(cached, server, false)).toBe(server)
  })

  it('garde une ligne du cache que le serveur n’a pas, même si les horloges sont égales', () => {
    const cached = entry('a', [message('old', T1)])
    const server = [message('x', T1)]
    expect(resolveSyncedMessages(cached, server, false).map((item) => item.id)).toEqual(['x', 'old'])
  })

  it('preserveLive garde l’objet du cache pour le même id et les lignes que seul le serveur a', () => {
    const live = message('row-1', T2, { content: 'on screen' })
    const stale = message('row-1', T1, { content: 'server copy' })
    const tool = message('tool-1', T1, { role: 'tool', content: 'step' })
    const merged = resolveSyncedMessages(entry('a', [live]), [stale, tool], true)
    expect(merged.map((item) => item.id)).toEqual(['row-1', 'tool-1'])
    expect(merged[0]).toBe(live)
  })

  it('sans cache, la copie serveur fait foi', () => {
    const server = [message('a', T1)]
    expect(resolveSyncedMessages(undefined, server, true)).toBe(server)
  })

  const FUTURE = '2099-01-01T00:00:00.000Z'
  const PAST = '2000-01-01T00:00:00.000Z'

  it('keeps server tool rows and a live cache row, whichever clock is ahead', () => {
    const cases = [
      { cacheTime: FUTURE, serverTime: PAST },
      { cacheTime: PAST, serverTime: FUTURE },
    ]
    for (const { cacheTime, serverTime } of cases) {
      const cachedUser = message('local-user', cacheTime, { role: 'user', content: 'Hello' })
      const live = message('live-1', cacheTime, { content: 'Not on the server yet' })
      const serverUser = message('row-user', serverTime, { role: 'user', content: 'Hello' })
      const tool = message('row-tool', serverTime, { role: 'tool', content: 'ran a tool' })
      const serverReply = message('row-reply', serverTime, { content: 'Server only reply' })
      const withLive = resolveSyncedMessages(entry('a', [cachedUser, live]), [serverUser, tool], false)
      expect(withLive.map((item) => item.id)).toEqual(['row-user', 'row-tool', 'live-1'])
      const serverOnly = resolveSyncedMessages(entry('a', [cachedUser]), [serverUser, serverReply], false)
      expect(serverOnly.map((item) => item.id)).toEqual(['row-user', 'row-reply'])
    }
  })

  it('keeps a fallback stamp when the server row replaces the cache body', () => {
    const answeredBy = { chosen: 'cursor/composer-2.5', provider: 'cursor', model: 'cursor/composer-2.5', fallback: true as const }
    const cachedRow = message('11945', T1, { content: 'Noté.', answeredBy })
    const serverRow = message('11945', T1, { content: 'Noté.' })
    const merged = resolveSyncedMessages(entry('a', [cachedRow]), [serverRow], false)
    expect(merged[0].answeredBy).toEqual(answeredBy)
    expect(merged[0].content).toBe('Noté.')
  })

  it('does not replace a cached row with a different body for the same id', () => {
    const cachedRow = message('row-1', PAST, { content: 'kept' })
    const serverRow = message('row-1', FUTURE, { content: 'other' })
    expect(resolveSyncedMessages(entry('a', [cachedRow]), [serverRow], false)[0]).toBe(cachedRow)
  })

  it('trimCachedMessages keeps the last 500 messages', () => {
    const messages = Array.from({ length: CHAT_CACHE_LIMIT + 1 }, (_, index) => message(`m${index}`))
    const trimmed = trimCachedMessages(messages)
    expect(trimmed).toHaveLength(CHAT_CACHE_LIMIT)
    expect(trimmed[0].id).toBe('m1')
    expect(trimmed.at(-1)?.id).toBe(`m${CHAT_CACHE_LIMIT}`)
    const few = messages.slice(0, 3)
    expect(trimCachedMessages(few)).toBe(few)
  })

  it('freshNotes écarte les notes déjà présentes', () => {
    expect(freshNotes([message('a')], [message('a'), message('b')]).map((item) => item.id)).toEqual(['b'])
  })

  it('markMessageFailed ne marque que le message visé', () => {
    const next = markMessageFailed([message('a'), message('b')], 'b')
    expect(next.map((item) => item.failed)).toEqual([undefined, true])
  })
})

describe('store de conversation', () => {
  beforeEach(resetChatStore)

  it('met à jour et complète le cache sans toucher aux profils absents', () => {
    const s = useChatStore.getState()
    s.setCached('a', entry('a', [message('m1')]))
    s.updateCachedChat('a', { running: true })
    s.updateCachedChat('absent', { running: true })
    s.appendCachedMessage('a', message('m2'))
    s.appendCachedMessage('absent', message('m3'))
    s.appendCachedNotes('a', [message('m2'), message('n1')])
    s.markCachedFailed('a', 'm1')
    const cached = s.getCached('a')!
    expect(cached.chat.running).toBe(true)
    expect(cached.messages.map((item) => item.id)).toEqual(['m1', 'm2', 'n1'])
    expect(cached.messages[0].failed).toBe(true)
    expect(s.getCached('absent')).toBeUndefined()
  })

  it('stopAllCachedRuns arrête les tours suivis avant la coupure', () => {
    const s = useChatStore.getState()
    s.setCached('a', entry('a', [], { running: true }))
    s.setCached('b', entry('b', []))
    s.stopAllCachedRuns()
    expect(s.getCached('a')!.chat.running).toBe(false)
    expect(s.getCached('b')!.chat.running).toBe(false)
  })

  it('le streaming et le titre de modèle acceptent une fonction', () => {
    const s = useChatStore.getState()
    s.setStreaming('Bon')
    s.setStreaming((value) => value + 'jour')
    expect(useChatStore.getState().streaming).toBe('Bonjour')
    s.setChatModel('m1')
    s.setChatModel((value) => value || 'm2')
    expect(useChatStore.getState().chatModel).toBe('m1')
  })

  it('retour sur un bot en cache : affichage instantané, sans chargement', () => {
    const s = useChatStore.getState()
    s.setCached('a', { ...entry('a', [message('m1')], { running: true, model: 'gpt' }), routines: [] })
    s.setStreaming('reste')
    s.setUsage(null)
    s.enterProfile('a')
    const state = useChatStore.getState()
    expect(state.messages.map((item) => item.id)).toEqual(['m1'])
    expect(state.chatLoading).toBe(false)
    expect(state.routinesLoading).toBe(false)
    expect(state.running).toBe(true)
    expect(state.chatModel).toBe('gpt')
    expect(state.streaming).toBe('')
  })

  it('premier passage sur un bot : vide et en chargement', () => {
    const s = useChatStore.getState()
    s.setMessages([message('x')])
    s.enterProfile('nouveau')
    const state = useChatStore.getState()
    expect(state.messages).toEqual([])
    expect(state.activeChat).toBeNull()
    expect(state.chatLoading).toBe(true)
    expect(state.routinesLoading).toBe(true)
  })

  it('showProfileFromList ne touche ni le modèle ni l’usage', () => {
    const s = useChatStore.getState()
    s.setChatModel('garde')
    s.showProfileFromList('nouveau')
    expect(useChatStore.getState().chatModel).toBe('garde')
    expect(useChatStore.getState().chatLoading).toBe(true)
  })

  it('applySyncedChat garde les messages affichés quand un tour est en direct', () => {
    const s = useChatStore.getState()
    s.setMessages([message('live')])
    const synced = { chat: chat('a', { running: true }), messages: [message('cache')], routines: [] }
    s.applySyncedChat('a', synced, { preserveLive: true, resumed: false })
    const state = useChatStore.getState()
    expect(state.messages.map((item) => item.id)).toEqual(['live'])
    expect(state.running).toBe(true)
    expect(s.getCached('a')).toMatchObject({ chat: synced.chat, messages: synced.messages })
  })

  it('applySyncedChat garde Auto sur le sélecteur malgré un modèle de session routé', () => {
    const s = useChatStore.getState()
    s.setCached('a', { ...entry('a', []), pickerModel: AUTO_MODEL_SENTINEL })
    s.setActiveChat(chat('a', { model: 'kimi-for-coding' }))
    s.setChatModel(AUTO_MODEL_SENTINEL)
    const synced = { chat: chat('a', { model: 'gemma-local' }), messages: [message('m')], routines: [] }
    s.applySyncedChat('a', synced, { preserveLive: false, resumed: true })
    expect(useChatStore.getState().chatModel).toBe(AUTO_MODEL_SENTINEL)
    expect(s.getCached('a')?.pickerModel).toBe(AUTO_MODEL_SENTINEL)
    expect(s.getCached('a')?.chat.model).toBe('gemma-local')
  })

  it('enterProfile restaure le sentinel Auto depuis le cache', () => {
    const s = useChatStore.getState()
    s.setCached('a', { ...entry('a', [message('m1')], { model: 'kimi-for-coding' }), pickerModel: AUTO_FREE_MODEL_SENTINEL })
    s.enterProfile('a')
    expect(useChatStore.getState().chatModel).toBe(AUTO_FREE_MODEL_SENTINEL)
  })

  it('applySyncedChat après une coupure vide le streaming d’un tour fini', () => {
    const s = useChatStore.getState()
    s.setStreaming('reste')
    s.setStreamKey('k')
    s.setActivity('outil')
    s.applySyncedChat('a', { chat: chat('a'), messages: [message('m')], routines: [] }, { preserveLive: false, resumed: true })
    const state = useChatStore.getState()
    expect(state.messages.map((item) => item.id)).toEqual(['m'])
    expect([state.streaming, state.streamKey, state.activity]).toEqual(['', '', ''])
  })

  it('caps each cached transcript at the last 500 messages', () => {
    const s = useChatStore.getState()
    const many = Array.from({ length: CHAT_CACHE_LIMIT + 1 }, (_, index) => message(`m${index}`))
    s.setCached('a', entry('a', many))
    expect(s.getCached('a')!.messages.map((item) => item.id)[0]).toBe('m1')
    expect(s.getCached('a')!.messages).toHaveLength(CHAT_CACHE_LIMIT)
    s.appendCachedMessage('a', message('tail'))
    const ids = s.getCached('a')!.messages.map((item) => item.id)
    expect(ids).toHaveLength(CHAT_CACHE_LIMIT)
    expect(ids[0]).toBe('m2')
    expect(ids.at(-1)).toBe('tail')
    // The thread on screen keeps the whole history: only the stored cache is capped.
    s.setMessages(many)
    expect(useChatStore.getState().messages).toHaveLength(CHAT_CACHE_LIMIT + 1)
  })

  it('applySyncedChat laisse le streaming d’un tour encore en cours', () => {
    const s = useChatStore.getState()
    s.setStreaming('en cours')
    s.applySyncedChat('a', { chat: chat('a', { running: true }), messages: [], routines: [] }, { preserveLive: false, resumed: true })
    expect(useChatStore.getState().streaming).toBe('en cours')
  })
})

describe('resolveSyncedMessages on a long history', () => {
  it('stays linear: 500 cached rows against 5000 server rows in well under a second', () => {
    const body = 'Lorem ipsum dolor sit amet, '.repeat(80)
    const server = Array.from({ length: 5000 }, (_, index) => ({
      id: `s${index}`, role: index % 2 ? 'assistant' : 'user', content: `${body} ${index}`, createdAt: '2026-11-16T00:00:00Z',
    })) as ChatMessage[]
    const cached = server.slice(-500).map((message, index) => ({ ...message, id: `live-${index}` }))
    cached.push({ id: 'live-new', role: 'user', content: 'pas encore sur le serveur', createdAt: '2026-11-16T00:00:01Z' })
    const started = performance.now()
    const merged = resolveSyncedMessages({ chat: {} as ActiveChat, messages: cached, routines: [] }, server, false)
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(merged).toHaveLength(5001)
    expect(merged.at(-1)?.id).toBe('live-new')
  })

  it('accepts a row without text content', () => {
    const server = [{ id: 'a', role: 'tool', content: undefined as unknown as string, createdAt: '2026-11-16T00:00:00Z' }] as ChatMessage[]
    const cached = [{ id: 'b', role: 'tool', content: undefined as unknown as string, createdAt: '2026-11-16T00:00:00Z' }] as ChatMessage[]
    expect(() => resolveSyncedMessages({ chat: {} as ActiveChat, messages: cached, routines: [] }, server, false)).not.toThrow()
  })
})
