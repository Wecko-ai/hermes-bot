import './test-dom'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, expect, it } from 'vitest'
import type { HermesClient } from '../lib/hermes'
import { EmailDraftsDock } from './EmailDraftCard'
import { buttonByText, fieldByLabel, installTestDom, typeInto } from './test-dom'

const draft = {
  id: 'ed_0123456789abcdef', rev: 1, status: 'pending', from: 'contact@exemple.test', signature: '--\nAlice',
  to: ['sam@exemple.test'], cc: [], bcc: [], subject: 'Devis', body: 'Bonjour Sam', session_id: 's1', updated_at: Date.now() / 1000,
  attachments: [{ path: '/w/devis.pdf', name: 'devis.pdf', size: 2048 }],
}

describe('EmailDraftsDock', () => {
  it('shows the draft, sends nothing on its own, and sends the edits on Envoyer', async () => {
    const { container } = installTestDom()
    const calls: Array<Record<string, unknown>> = []
    let current: Record<string, unknown> = draft
    const client = { request: async (_method: string, params: Record<string, unknown>) => {
      calls.push(params)
      if (params.op === 'send') { current = { ...current, body: params.body, status: 'sent', sent_at: Date.now() / 1000, sent_by: 'human' }; return { ok: true, draft: current } }
      return { ok: true, drafts: [current], rules: { mode: 'approval', allowed: [] } }
    } } as unknown as HermesClient
    const root = createRoot(container as unknown as Element)
    await act(async () => {
      root.render(createElement(EmailDraftsDock, { client, profile: 'alice', sessionId: 's1', botName: 'Alice', running: false }))
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(container.textContent).toContain('devis.pdf')
    expect(container.textContent).toContain('Approbation requise')
    expect(calls.every((params) => params.op === 'list')).toBe(true)
    const body = fieldByLabel(container, 'Corps du mail')
    await act(async () => { typeInto(body!, 'Bonjour Sam, voici le devis.') })
    await act(async () => {
      buttonByText(container, 'Envoyer')?.click()
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    const sends = calls.filter((params) => params.op === 'send')
    expect(sends).toHaveLength(1)
    expect(sends[0]).toMatchObject({ id: draft.id, rev: 1, body: 'Bonjour Sam, voici le devis.' })
    expect(container.textContent).toContain('Envoyé à')
    await act(async () => { root.unmount() })
  })

  it('renders nothing when the bot has no email-drafts plugin', async () => {
    const { container } = installTestDom()
    const client = { request: async () => { throw Object.assign(new Error('unknown'), {}) } } as unknown as HermesClient
    const root = createRoot(container as unknown as Element)
    await act(async () => {
      root.render(createElement(EmailDraftsDock, { client, profile: 'alice', sessionId: 's1', botName: 'Alice', running: false }))
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(container.textContent).toBe('')
    await act(async () => { root.unmount() })
  })
})
