import './test-dom'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { APPROVED_MAIL_INSTRUCTION } from '../lib/mail'
import type { Bot, ChatMessage } from '../types'
import { AgentNote, MessageList, autoRouteModel, autoRoutesByMessage, autoRouteTitle, currentAutoRoute } from './MessageList'
import { installTestDom } from './test-dom'

const bot = (extra: Partial<Bot> = {}): Bot => ({
  slug: 'demo', name: 'Demo', role: 'Helper', section: 'Team', sectionId: 'team', model: 'local',
  status: 'idle', preview: '', timestamp: null, unread: 0, hidden: false, ...extra,
})

const at = '2026-11-16T00:00:00.000Z'
const message = (extra: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role' | 'content'>): ChatMessage => ({ createdAt: at, ...extra })

const approved = [
  '```hermes-mail-approved',
  'Id: m1',
  'From: Bot <bot@exemple.test>',
  'To: a@exemple.test',
  'Subject: Bonjour',
  '',
  'Corps',
  '```',
].join('\n')

function list(extra: Partial<Parameters<typeof MessageList>[0]> = {}) {
  return createElement(MessageList, {
    bot: bot(),
    bots: [],
    messages: [],
    streaming: '',
    streamKey: '',
    running: false,
    activity: '',
    workText: '',
    loading: false,
    onSuggestion: () => true,
    onOpenDocument: () => undefined,
    onOpenBot: () => undefined,
    ...extra,
  })
}

const noteText = [
  'Link: https://x.com/example/status/1',
  '',
  'Text:',
  '```',
  'Wire sent.',
  '```',
  '',
  'MEDIA:/tmp/picture.png',
  '',
  '```hermes-mail',
  'Id: m1',
  'From: Bot <bot@exemple.test>',
  'To: a@exemple.test',
  'Subject: Secret',
  '',
  'Hello there',
  '```',
  '',
  approved,
].join('\n')

describe('MessageList', () => {
  it('renders a streaming local reply as plain text and markdown once it is finished', () => {
    const streaming = renderToStaticMarkup(list({ streamReply: true, streaming: '**not bold**', streamKey: 'live', running: true }))
    expect(streaming).toContain('stream-plain')
    expect(streaming).toContain('**not bold**')
    expect(streaming).toContain('aria-hidden="true"')
    expect(streaming).not.toContain('<strong>')
    const done = renderToStaticMarkup(list({
      streamReply: true,
      messages: [message({ id: 'a', role: 'assistant', content: '**bold**' })],
    }))
    expect(done).toContain('<strong>bold</strong>')
    expect(done).not.toContain('stream-plain')
  })

  it('shows an approved-mail receipt only in a user message and hides the model instruction', () => {
    const user = renderToStaticMarkup(list({
      messages: [message({ id: 'u', role: 'user', content: `${APPROVED_MAIL_INSTRUCTION}\n\n${approved}` })],
    }))
    expect(user).toContain('mail-note')
    expect(user).toContain('Bonjour, à a@exemple.test')
    expect(user).not.toContain(APPROVED_MAIL_INSTRUCTION)
    const assistant = renderToStaticMarkup(list({
      messages: [message({ id: 'a', role: 'assistant', content: approved })],
    }))
    expect(assistant).not.toContain('mail-note')
    expect(assistant).not.toContain('Bonjour, à a@exemple.test')
    expect(assistant).toContain('<pre>')
  })

  it('does not turn a data url into an image', () => {
    const html = renderToStaticMarkup(list({
      messages: [message({ id: 'a', role: 'assistant', content: 'Look ![Shot](data:image/png;base64,aaaa)' })],
    }))
    expect(html).not.toContain('<img')
    expect(html).toContain('Shot')
  })

  it('renders a note between bots without a mail card or a tweet card, media kept', () => {
    const html = renderToStaticMarkup(createElement(AgentNote, {
      message: message({
        id: 'note',
        role: 'user',
        content: '',
        agent: { kind: 'reply', from: 'alpha', to: 'beta', text: noteText },
      }),
      profile: 'demo',
      initiallyOpen: true,
      onOpenImages: () => undefined,
      onOpenDocument: () => undefined,
    }))
    expect(html).toContain('Hello there')
    expect(html).toContain('Wire sent.')
    expect(html).not.toContain('mail-card')
    expect(html).not.toContain('mail-note')
    expect(html).not.toContain('tweet-card')
    // Files a bot cites in a reply to another bot stay viewable (product rule), through /api/media only.
    expect(html).not.toContain('file://')
  })

  it('announces a local reply once, when streaming finishes, not on each token', async () => {
    const { container } = installTestDom()
    const root = createRoot(container as unknown as Element)
    const render = (streaming: string, messages: ChatMessage[] = [], streamKey = 'live') => act(async () => {
      root.render(list({ streamReply: true, streaming, streamKey, messages, running: Boolean(streaming) }))
    })
    await render('tok-1')
    await render('tok-1 tok-2')
    const region = () => container.querySelector('.visually-hidden')
    expect(region()?.getAttribute('aria-live')).toBe('polite')
    expect(region()?.textContent).toBe('')
    expect(container.textContent).toContain('tok-1 tok-2')
    await render('', [message({ id: 'live', role: 'assistant', content: 'FULL-REPLY' })], '')
    expect(region()?.textContent).toBe('FULL-REPLY')
    await act(async () => { root.unmount() })
  })

  it('shows a calm empty state before the first message', () => {
    const html = renderToStaticMarkup(list({ loading: false, messages: [] }))
    expect(html).toContain('chat-empty')
    expect(html).toContain('Demo')
    expect(html).toContain('Helper')
  })

  it('styles a failed outbound message in the meta and bubble', () => {
    const html = renderToStaticMarkup(list({
      messages: [message({ id: 'f', role: 'user', content: 'Hello', failed: true })],
    }))
    expect(html).toContain('is-failed')
    expect(html).toMatch(/sendFailed|Échec|Failed to send/i)
  })

  it('does not announce a reply that was already finished when the list opened', async () => {
    const { container } = installTestDom()
    const root = createRoot(container as unknown as Element)
    await act(async () => {
      root.render(list({
        streamReply: true,
        messages: [message({ id: 'a', role: 'assistant', content: 'Already there' })],
      }))
    })
    expect(container.querySelector('.visually-hidden')?.textContent).toBe('')
    await act(async () => { root.unmount() })
  })
})

describe('Auto routing labels', () => {
  const route = { mode: 'auto' as const, category: 'code', chosen: 'openrouter/moonshot/kimi-k2.8', reason: 'best score for code' }
  const free = { mode: 'auto-free' as const, category: 'chat', chosen: 'nvidia/llama-4', reason: 'free tier' }

  it('names the short model and keeps category and reason for the tooltip', () => {
    expect(autoRouteModel(route)).toBe('Kimi K2.8 · OpenRouter')
    expect(autoRouteTitle(route)).toBe('openrouter/moonshot/kimi-k2.8 · code · best score for code')
  })

  it('maps each reply to the pick of the user turn before it, skipping milestones', () => {
    const messages = [
      message({ id: 'u1', role: 'user', content: 'a', autoRoute: route }),
      message({ id: 'p1', role: 'assistant', content: 'step', progress: true }),
      message({ id: 'a1', role: 'assistant', content: 'done' }),
      message({ id: 'u2', role: 'user', content: 'b' }),
      message({ id: 'a2', role: 'assistant', content: 'plain' }),
    ]
    const { replies, answered } = autoRoutesByMessage(messages)
    expect(replies.get('a1')).toBe(route)
    expect(replies.has('p1')).toBe(false)
    expect(replies.has('a2')).toBe(false)
    expect(answered.has('u1')).toBe(true)
    expect(currentAutoRoute(messages)).toBeUndefined()
    expect(currentAutoRoute(messages.slice(0, 2))).toBe(route)
  })

  const renderLive = async (extra: Partial<Parameters<typeof MessageList>[0]>) => {
    const { container } = installTestDom()
    const root = createRoot(container as unknown as Element)
    await act(async () => { root.render(list(extra)) })
    const labels = Array.from(container.querySelectorAll('.working-auto-route, .message-auto-route')).map((node) => ({
      className: node.getAttribute('class'), text: node.textContent, title: node.getAttribute('title'),
    }))
    await act(async () => { root.unmount() })
    return labels
  }

  it('shows the routed model on the working line while the bot works', async () => {
    const labels = await renderLive({
      running: true,
      messages: [message({ id: 'u1', role: 'user', content: 'Hello', autoRoute: route })],
    })
    // Shown once: on the working line, not again on the user bubble.
    expect(labels).toHaveLength(1)
    expect(labels[0].className).toBe('working-auto-route')
    expect(labels[0].text).toContain('Kimi K2.8 · OpenRouter')
    expect(labels[0].title).toContain('best score for code')
  })

  it('keeps a small label on the finished answer, not on the question', () => {
    const html = renderToStaticMarkup(list({
      messages: [
        message({ id: 'u1', role: 'user', content: 'Hello', autoRoute: free }),
        message({ id: 'a1', role: 'assistant', content: 'Hi' }),
      ],
    }))
    expect(html).not.toContain('working-auto-route')
    expect(html.match(/class="message-auto-route"/g)?.length).toBe(1)
    expect(html).toMatch(/message-assistant[\s\S]*message-auto-route[\s\S]*Llama 4 · NVIDIA/)
  })

  it('shows no label outside Auto mode', async () => {
    const labels = await renderLive({
      running: true,
      messages: [message({ id: 'u1', role: 'user', content: 'Hello' }), message({ id: 'a1', role: 'assistant', content: 'Hi' })],
    })
    expect(labels).toHaveLength(0)
  })
})
