import { beforeEach, describe, expect, it } from 'vitest'
import type { ChatMessage } from '../types'
import type { ActiveChat } from '../lib/hermes'
import { freshNotes, latestMessageTime, markMessageFailed, resetChatStore, resolveSyncedMessages, useChatStore, type ChatCacheEntry } from './chat'

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
    expect(resolveSyncedMessages(cached, [message('old', T1)], false)).toBe(cached.messages)
  })

  it('prend la copie serveur quand elle est aussi récente ou plus récente', () => {
    const cached = entry('a', [message('old', T1)])
    const server = [message('old', T1), message('new', T2)]
    expect(resolveSyncedMessages(cached, server, false)).toBe(server)
    const same = [message('x', T1)]
    expect(resolveSyncedMessages(cached, same, false)).toBe(same)
  })

  it('garde le cache quand un tour est suivi en direct, même si le serveur est plus récent', () => {
    const cached = entry('a', [message('old', T1)])
    expect(resolveSyncedMessages(cached, [message('new', T2)], true)).toBe(cached.messages)
  })

  it('sans cache, la copie serveur fait foi', () => {
    const server = [message('a', T1)]
    expect(resolveSyncedMessages(undefined, server, true)).toBe(server)
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
    expect(s.getCached('a')).toBe(synced)
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

  it('applySyncedChat laisse le streaming d’un tour encore en cours', () => {
    const s = useChatStore.getState()
    s.setStreaming('en cours')
    s.applySyncedChat('a', { chat: chat('a', { running: true }), messages: [], routines: [] }, { preserveLive: false, resumed: true })
    expect(useChatStore.getState().streaming).toBe('en cours')
  })
})
