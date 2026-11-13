import { describe, expect, it } from 'vitest'
import { DEMO_LOCAL_MODEL, demoChat, demoData } from './demo'
import { canSendMail, parseMailBlock } from './mail'
import { findQuestions } from './questions'
import { stepIds } from './turns'

const shape = (language: 'en' | 'fr') => {
  const demo = demoData(language)
  const ids = (messages: { id: string; role: string; delivery?: string }[]) => messages.map(({ id, role, delivery }) => [id, role, delivery ?? ''].join(':'))
  return {
    messages: ids(demo.messages),
    chats: Object.fromEntries(Object.entries(demo.chats).map(([slug, chat]) => [slug, ids(chat ?? [])])),
    local: ids(demo.local.messages),
  }
}

describe('demo data', () => {
  it('has the same conversations in English and French', () => {
    expect(shape('fr')).toEqual(shape('en'))
    expect(demoData('fr').chats.sage?.[1].content).not.toBe(demoData('en').chats.sage?.[1].content)
  })

  describe.each(['en', 'fr'] as const)('in %s', (language) => {
    const demo = demoData(language)
    const bot = (slug: string) => demo.bots.find((item) => item.slug === slug)

    it('gives some bots a conversation of their own, the others the shared one', () => {
      for (const slug of Object.keys(demo.chats)) expect(bot(slug)).toBeDefined()
      expect(demoChat(demo, 'nova')).toBe(demo.messages)
      expect(demoChat(demo, 'iris')).toBe(demo.messages)
      expect(demoChat(demo, 'sage')).toBe(demo.chats.sage)
      const all = [...demo.messages, ...Object.values(demo.chats).flatMap((chat) => chat ?? []), ...demo.local.messages].map((message) => message.id)
      expect(new Set(all).size).toBe(all.length)
    })

    it("shows Sage's draft as a mail card waiting for approval", () => {
      const reply = demo.chats.sage?.at(-1)
      expect(reply?.role).toBe('assistant')
      const block = /```hermes-mail\n([\s\S]*?)\n```/.exec(reply?.content ?? '')
      const draft = block && parseMailBlock(block[1])
      expect(draft).toMatchObject({ id: 'demo-mail-invoice', from: 'you@example.com', to: 'billing@printshop.example', cc: '' })
      expect(draft && canSendMail(draft)).toBe(true)
    })

    it("ends Lyra's latest reply with open questions, Lyra waiting", () => {
      const reply = demo.chats.lyra?.at(-1)
      expect(reply?.role).toBe('assistant')
      // The strict rule: the card shows even when the reply is not the latest one.
      expect(findQuestions(reply?.content ?? '', false)?.questions).toHaveLength(2)
      expect(bot('lyra')?.status).toBe('waiting')
    })

    it("keeps Orion's turn running, with a queued and a priority message", () => {
      const chat = demo.chats.orion ?? []
      expect(chat.map((message) => message.delivery).filter(Boolean)).toEqual(['queue', 'priority'])
      expect(chat.slice(-2).every((message) => message.role === 'user')).toBe(true)
      expect(bot('orion')?.status).toBe('working')
      // Nothing of the thread folds into the working line.
      expect(stepIds(chat, true, 'orion').size).toBe(0)
    })

    it('opens the local chat on a fictional model, with a fixed reply', () => {
      expect(demo.local.model).toBe(DEMO_LOCAL_MODEL)
      expect(demo.local.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
      expect(demo.local.answer).toMatch(/Ollama/)
    })
  })
})
