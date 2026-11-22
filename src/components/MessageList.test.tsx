import './test-dom'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { APPROVED_MAIL_INSTRUCTION } from '../lib/mail'
import type { Bot, ChatMessage } from '../types'
import { AgentNote, MessageList } from './MessageList'
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

  it('renders a progress note as a compact bubble, separate from the answer', () => {
    const html = renderToStaticMarkup(list({
      messages: [
        message({ id: 'k', role: 'assistant', content: 'On it.', ack: true }),
        message({ id: 'p', role: 'assistant', content: 'Tests are running.', progress: true }),
        message({ id: 'a', role: 'assistant', content: 'All green.' }),
      ],
    }))
    expect(html).toContain('progress-bubble')
    expect(html).toContain('Tests are running.')
    expect(html).toContain('is-ack')
    expect(html).toContain('All green.')
    const progressAt = html.indexOf('progress-bubble')
    const answerAt = html.indexOf('All green.')
    expect(progressAt).toBeGreaterThan(html.indexOf('is-ack'))
    expect(answerAt).toBeGreaterThan(progressAt)
    expect(html.slice(progressAt, answerAt)).not.toContain('message-copy')
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
