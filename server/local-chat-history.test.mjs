import { describe, expect, it } from 'vitest'
import { cleanMessages, conversationTitle, createLocalChatHistory } from './local-chat-history.mjs'

const message = (id, role, content) => ({ id, role, content, createdAt: '2026-11-16T14:00:00.000Z' })
const exchange = [message('u1', 'user', 'Bonjour\nsuite'), message('a1', 'assistant', 'Salut')]

function memoryStore(initial = null) {
  const store = { text: initial, saves: 0, fail: false, unreadable: false }
  store.load = () => { if (store.unreadable) throw new Error('locked'); return store.text }
  store.save = (text) => { if (store.fail) throw new Error('disk'); store.text = text; store.saves += 1 }
  return store
}

describe('historique du chat local', () => {
  it('garde, liste et relit une conversation', () => {
    const store = memoryStore()
    const history = createLocalChatHistory(store)
    expect(history.save('conversation-1', { model: 'qwen3:4b', messages: exchange }, '2026-11-16T14:01:00.000Z')).toBe('')
    expect(history.list()).toEqual({ readable: true, conversations: [{ id: 'conversation-1', title: 'Bonjour', model: 'qwen3:4b', createdAt: '2026-11-16T14:01:00.000Z', updatedAt: '2026-11-16T14:01:00.000Z', count: 2 }] })
    // A new server reads the same file.
    const reread = createLocalChatHistory(store).get('conversation-1')
    expect(reread?.messages).toEqual(exchange)
    expect(reread?.title).toBe('Bonjour')
  })

  it('met la conversation modifiée en tête et garde sa date de création', () => {
    const history = createLocalChatHistory(memoryStore())
    history.save('conversation-1', { messages: exchange }, '2026-11-16T14:01:00.000Z')
    history.save('conversation-2', { messages: exchange }, '2026-11-16T14:02:00.000Z')
    history.save('conversation-1', { messages: [...exchange, message('u2', 'user', 'Encore')] }, '2026-11-16T14:03:00.000Z')
    const [first, second] = history.list().conversations
    expect([first.id, second.id]).toEqual(['conversation-1', 'conversation-2'])
    expect(first.createdAt).toBe('2026-11-16T14:01:00.000Z')
    expect(first.count).toBe(3)
  })

  it('refuse tout ce qui n’est pas un message du chat local', () => {
    const history = createLocalChatHistory(memoryStore())
    expect(history.save('court', { messages: exchange })).toBe('invalid_conversation')
    expect(history.save('../../etc', { messages: exchange })).toBe('invalid_conversation')
    expect(history.save('conversation-1', { messages: [message('s1', 'system', 'x')] })).toBe('invalid_messages')
    expect(history.save('conversation-1', { messages: [] })).toBe('invalid_messages')
    expect(cleanMessages([{ ...message('u1', 'user', 'x'), tools: [1] }])).toEqual([message('u1', 'user', 'x')])
    expect(history.save('conversation-1', { model: '-pas un modèle', messages: exchange })).toBe('')
    expect(history.get('conversation-1')?.model).toBe('')
  })

  it('n’écrase jamais un fichier illisible', () => {
    const store = memoryStore('{"conversations":[]}')
    store.unreadable = true
    const history = createLocalChatHistory(store)
    expect(history.list().readable).toBe(false)
    expect(history.save('conversation-1', { messages: exchange })).toBe('history_unreadable')
    expect(history.remove('conversation-1')).toBe('history_unreadable')
    expect(store.saves).toBe(0)
    // Readable again (Keychain unlocked): it works without a restart.
    store.unreadable = false
    expect(history.save('conversation-1', { messages: exchange })).toBe('')
    expect(createLocalChatHistory(memoryStore('pas du json')).save('conversation-1', { messages: exchange })).toBe('history_unreadable')
  })

  it('garde l’état d’avant si l’écriture échoue', () => {
    const store = memoryStore()
    const history = createLocalChatHistory(store)
    history.save('conversation-1', { messages: exchange })
    store.fail = true
    expect(history.save('conversation-2', { messages: exchange })).toBe('history_unwritable')
    expect(history.remove('conversation-1')).toBe('history_unwritable')
    expect(history.list().conversations.map((item) => item.id)).toEqual(['conversation-1'])
  })

  it('respecte les limites sans rien effacer', () => {
    const history = createLocalChatHistory(memoryStore(), { conversations: 1, conversationBytes: 2000, storeBytes: 4000 })
    expect(history.save('conversation-1', { messages: exchange })).toBe('')
    expect(history.save('conversation-2', { messages: exchange })).toBe('history_full')
    expect(history.save('conversation-1', { messages: [message('u1', 'user', 'x'.repeat(3000))] })).toBe('conversation_too_large')
    expect(history.get('conversation-1')?.messages).toEqual(exchange)
  })

  it('supprime une conversation', () => {
    const history = createLocalChatHistory(memoryStore())
    history.save('conversation-1', { messages: exchange })
    expect(history.remove('conversation-1')).toBe('')
    expect(history.remove('conversation-1')).toBe('')
    expect(history.list().conversations).toEqual([])
  })

  it('vit en mémoire sans coffre chiffré', () => {
    const history = createLocalChatHistory(null)
    expect(history.persistent).toBe(false)
    expect(history.save('conversation-1', { messages: exchange })).toBe('')
    expect(history.list().conversations).toHaveLength(1)
  })

  it('titre : première ligne du premier message, coupée', () => {
    expect(conversationTitle([message('a', 'assistant', 'x'), message('u', 'user', '  Un   titre\nla suite')])).toBe('Un titre')
    expect(conversationTitle([message('u', 'user', 'y'.repeat(100))])).toHaveLength(80)
  })
})
