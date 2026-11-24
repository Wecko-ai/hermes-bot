import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Bot, ChatMessage } from '../types'
import { MessageList } from './MessageList'

const bot = (): Bot => ({
  slug: 'demo', name: 'Demo', role: 'Helper', section: 'Team', sectionId: 'team', model: 'local',
  status: 'idle', preview: '', timestamp: null, unread: 0, hidden: false,
})

/** What a cold paint of a long thread costs before virtualization has a viewport (every row). */
describe('message list paint', () => {
  it('renders 500 messages', async () => {
    const messages: ChatMessage[] = Array.from({ length: 500 }, (_, index) => ({
      id: String(index + 1),
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: index % 2 === 0
        ? `Question ${index} about the build.`
        : `Reply ${index}.\n\n- one\n- two\n\nSee \`src/app.ts\` and https://example.test/${index}.`,
      createdAt: '2026-11-23T00:00:00.000Z',
    }))
    const started = performance.now()
    const html = renderToStaticMarkup(createElement(MessageList, {
      bot: bot(),
      bots: [],
      messages,
      streaming: '',
      streamKey: '',
      running: false,
      activity: '',
      workText: '',
      loading: false,
      onSuggestion: () => true,
      onOpenDocument: () => undefined,
      onOpenBot: () => undefined,
    }))
    const ms = Math.round(performance.now() - started)
    const visible = messages.slice(-24)
    const windowStarted = performance.now()
    const windowHtml = renderToStaticMarkup(createElement(MessageList, {
      bot: bot(),
      bots: [],
      messages: visible,
      streaming: '',
      streamKey: '',
      running: false,
      activity: '',
      workText: '',
      loading: false,
      onSuggestion: () => true,
      onOpenDocument: () => undefined,
      onOpenBot: () => undefined,
    }))
    const windowMs = Math.round(performance.now() - windowStarted)
    expect(html.match(/class="message /g)?.length).toBe(500)
    expect(windowHtml.match(/class="message /g)?.length).toBe(24)
    expect(ms).toBeGreaterThan(0)
    // The conversation-open bench reads this file. It is not a pass/fail budget.
    const { writeFileSync } = await import('node:fs')
    writeFileSync('/tmp/conv-cache-render-ms.txt', `${ms} ${windowMs}\n`)
  })
})
