import './test-dom'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, expect, it } from 'vitest'
import { QuestionsCard } from './QuestionsCard'
import { MailContext } from './MailCard'
import { buttonByText, installTestDom } from './test-dom'

const block = { before: '', after: '', heading: 'Questions', questions: ['Ready?'] }

async function renderCard(onApprove: (prompt: string) => Promise<boolean>, id = 'q1') {
  const { container } = installTestDom()
  localStorage.setItem('hermesbot-question-drafts', JSON.stringify({ [`bot:${id}`]: ['Oui'] }))
  const root = createRoot(container as unknown as Element)
  await act(async () => {
    root.render(createElement(MailContext.Provider, {
      value: { profile: 'bot', running: false, approved: new Set<string>(), onApprove },
    }, createElement(QuestionsCard, { id, block })))
  })
  return { container, root }
}

async function clickSend(container: ReturnType<typeof installTestDom>['container']) {
  const button = buttonByText(container, 'Envoyer les réponses')
  expect(button?.disabled).toBe(false)
  await act(async () => {
    button?.click()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

describe('QuestionsCard', () => {
  it('keeps the form and does not mark the question sent when the send is refused', async () => {
    let calls = 0
    const { container, root } = await renderCard(async () => {
      calls += 1
      return false
    })
    await clickSend(container)
    expect(calls).toBe(1)
    expect(container.textContent).not.toContain('Réponse envoyée')
    expect(container.textContent).toContain('Ready?')
    expect(localStorage.getItem('hermesbot-question-sent')).toBeNull()
    const drafts = JSON.parse(localStorage.getItem('hermesbot-question-drafts') || '{}') as Record<string, string[]>
    expect(drafts['bot:q1']).toEqual(['Oui'])
    await act(async () => { root.unmount() })
  })

  it('marks the question sent only after the send is accepted', async () => {
    const { container, root } = await renderCard(async () => true, 'q2')
    await clickSend(container)
    expect(container.textContent).toContain('Réponse envoyée')
    expect(container.textContent).not.toContain('Ready?')
    const sent = JSON.parse(localStorage.getItem('hermesbot-question-sent') || '{}') as Record<string, string[]>
    expect(sent['bot:q2']).toEqual(['Oui'])
    expect(JSON.parse(localStorage.getItem('hermesbot-question-drafts') || '{}')).toEqual({})
    await act(async () => { root.unmount() })
  })
})
