import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot, ChatMessage } from '../types'
import { resetChatStore, resetRosterStore, useChatStore, useRosterStore } from '../store'
import { BOT_KICKOFF_TEXT } from './bot-kickoff'
import { introduceDemoBot, kickOffNewBot, type FreshBot } from './bot-onboarding'
import type { ActiveChat } from './hermes'

const chat: ActiveChat = { profile: 'lea-martin', sessionId: 'chat-lea-martin', revision: 1, executionGeneration: 1, running: false, socketGeneration: 1 }
const fresh: FreshBot = { slug: 'lea-martin', title: 'Léa Martin', kickoff: true, attempts: 0 }
const bot: Bot = { slug: 'lea-martin', name: 'Léa Martin', role: '', section: '', sectionId: '', model: '', status: 'idle', preview: '', timestamp: null, unread: 0, hidden: false }

describe('premier tour d’un bot créé ici', () => {
  beforeEach(() => {
    resetChatStore()
    resetRosterStore()
    useRosterStore.setState({ bots: [bot], selected: 'lea-martin' })
    useChatStore.setState({ activeChat: chat })
  })

  it('part une fois, hors du fil, avec la consigne dans api_text et sans mode ni caveman', async () => {
    const request = vi.fn().mockResolvedValue({ status: 'started' })
    const sent = await kickOffNewBot({ request }, { chat, messages: [] }, fresh, 'fr', vi.fn())
    expect(sent).toBe(true)
    expect(request.mock.calls.map(([method]) => method)).toEqual(['session.title', 'prompt.submit'])
    const [, params] = request.mock.calls[1]
    expect(params).toMatchObject({ profile: 'lea-martin', session_id: 'chat-lea-martin', text: BOT_KICKOFF_TEXT, queued: false })
    expect(params.api_text).toContain('Your name is "Léa Martin"')
    expect(params.api_text).toContain('in French')
    expect(params.api_text).not.toContain('caveman')
    expect(params.api_text).not.toContain('HermesBot mode')
    const { messages, running } = useChatStore.getState()
    expect(messages).toEqual([expect.objectContaining({ role: 'user', content: BOT_KICKOFF_TEXT, technical: true })])
    expect(running).toBe(true)
    expect(useRosterStore.getState().bots[0].status).toBe('working')
    expect(useRosterStore.getState().bots[0].preview).toBe('')
  })

  it('ne part pas dans une conversation déjà commencée, ni pour un bot sans modèle', async () => {
    const request = vi.fn().mockResolvedValue({})
    const written: ChatMessage[] = [{ id: '1', role: 'user', content: 'Bonjour', createdAt: null }]
    expect(await kickOffNewBot({ request }, { chat, messages: written }, fresh, 'fr', vi.fn())).toBe(false)
    expect(await kickOffNewBot({ request }, { chat: { ...chat, running: true }, messages: [] }, fresh, 'fr', vi.fn())).toBe(false)
    expect(await kickOffNewBot({ request }, { chat, messages: [] }, { ...fresh, kickoff: false }, 'fr', vi.fn())).toBe(false)
    expect(request).not.toHaveBeenCalled()
  })

  it('rend la main quand Hermes refuse l’envoi, sans laisser le bot au travail', async () => {
    const refused = new Error('permission_denied')
    const request = vi.fn(async (method: string) => { if (method === 'prompt.submit') throw refused; return {} })
    const onFailed = vi.fn()
    expect(await kickOffNewBot({ request }, { chat, messages: [] }, fresh, 'en', onFailed)).toBe(false)
    expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({ content: BOT_KICKOFF_TEXT }), refused)
    expect(useChatStore.getState().running).toBe(false)
    expect(useRosterStore.getState().bots[0].status).toBe('idle')
  })

  it('part quand même si Hermes ne sait pas titrer la session à l’avance', async () => {
    const request = vi.fn(async (method: string) => { if (method === 'session.title') throw new Error('unknown method'); return {} })
    expect(await kickOffNewBot({ request }, { chat, messages: [] }, fresh, 'en', vi.fn())).toBe(true)
    expect(request.mock.calls.at(-1)?.[0]).toBe('prompt.submit')
  })
})

describe('nouveau bot de la démo', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetChatStore()
    resetRosterStore()
    useRosterStore.setState({ bots: [bot], selected: 'lea-martin' })
    useChatStore.setState({ messages: [{ id: 'demo-1', role: 'user', content: 'Autre conversation', createdAt: null }] })
  })
  afterEach(() => vi.useRealTimers())

  it('part d’une conversation vide, travaille, puis demande son rôle', () => {
    introduceDemoBot('lea-martin', 'Léa Martin', 'fr', 1_000)
    expect(useChatStore.getState().messages).toEqual([])
    expect(useChatStore.getState().running).toBe(true)
    expect(useRosterStore.getState().bots[0].status).toBe('working')
    vi.advanceTimersByTime(1_000)
    expect(useChatStore.getState().messages).toEqual([expect.objectContaining({ role: 'assistant', content: expect.stringContaining('Quel rôle veux-tu me confier') })])
    expect(useChatStore.getState().running).toBe(false)
    expect(useRosterStore.getState().bots[0].status).toBe('done')
  })
})
