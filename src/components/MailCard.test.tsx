import './test-dom'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, expect, it } from 'vitest'
import { APPROVED_MAIL_INSTRUCTION } from '../lib/mail'
import { MailBlock, MailContext } from './MailCard'
import { buttonByText, fieldByLabel, installTestDom, typeInto } from './test-dom'

const source = [
  'Id: m-edit',
  'From: Bot <bot@exemple.test>',
  'To: a@exemple.test',
  'Subject: Bonjour',
  'Reply-Label: hier',
  'In-Reply-To: <root@exemple.test>',
  'References: <root@exemple.test>',
  '',
  'Corps du mail',
].join('\n')

function card(onApprove: (prompt: string) => Promise<boolean>) {
  return createElement(MailContext.Provider, {
    value: { profile: 'bot', running: false, approved: new Set<string>(), onApprove },
  }, createElement(MailBlock, { source, approvedBlock: false, streaming: false, role: 'assistant' }))
}

describe('MailCard', () => {
  it('shows the thread ids and keeps the edited draft when the send is refused', async () => {
    const { container } = installTestDom()
    const root = createRoot(container as unknown as Element)
    let prompt = ''
    await act(async () => { root.render(card(async (text) => { prompt = text; return false })) })
    expect(container.textContent).toContain('In-Reply-To')
    expect(container.textContent).toContain('<root@exemple.test>')
    expect(container.textContent).toContain('References')
    expect(container.textContent).toContain('hier')
    const subject = fieldByLabel(container, 'Objet')
    expect(subject).not.toBeNull()
    await act(async () => { typeInto(subject!, 'Nouveau sujet') })
    expect(subject?.value).toBe('Nouveau sujet')
    const send = buttonByText(container, 'Envoyer')
    expect(send?.disabled).toBe(false)
    await act(async () => {
      send?.click()
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    expect(prompt.startsWith(APPROVED_MAIL_INSTRUCTION)).toBe(true)
    expect(prompt).toContain('Subject: Nouveau sujet')
    expect(prompt).toContain('In-Reply-To: <root@exemple.test>')
    expect(prompt).toContain('References: <root@exemple.test>')
    expect(container.textContent).toContain('À approuver')
    await act(async () => { root.unmount() })
    const again = createRoot(container as unknown as Element)
    await act(async () => { again.render(card(async () => false)) })
    expect(fieldByLabel(container, 'Objet')?.value).toBe('Nouveau sujet')
    await act(async () => { again.unmount() })
  })
})
