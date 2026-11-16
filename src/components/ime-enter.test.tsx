import './test-dom'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, expect, it } from 'vitest'
import type { Bot, ChatMessage, ModelOption } from '../types'
import { ChatView } from './ChatView'
import { CommandPalette } from './CommandPalette'
import { Composer } from './Composer'
import { ModelPicker } from './ModelPicker'
import { fieldByLabel, installTestDom, pressKey, typeInto, walkElements } from './test-dom'

const bot = (extra: Partial<Bot> = {}): Bot => ({
  slug: 'demo', name: 'Alpha', role: 'Helper', section: 'Team', sectionId: 'team', model: 'local-small',
  status: 'idle', preview: '', timestamp: null, unread: 0, hidden: false, ...extra,
})

async function mounted(node: ReturnType<typeof createElement>) {
  const { container } = installTestDom()
  const root = createRoot(container as unknown as Element)
  await act(async () => { root.render(node) })
  return {
    container,
    unmount: () => act(async () => { root.unmount() }),
  }
}

describe('Enter during IME composition', () => {
  it('does not open a bot from the command palette', async () => {
    const selected: string[] = []
    let closed = 0
    const view = await mounted(createElement(CommandPalette, {
      bots: [bot()],
      onSelect: (item) => { selected.push(item.slug) },
      onClose: () => { closed += 1 },
    }))
    const field = fieldByLabel(view.container, 'Chercher un bot')
    expect(field).not.toBeNull()
    await act(async () => { pressKey(field!, 'Enter', { isComposing: true }) })
    await act(async () => { pressKey(field!, 'Enter', { keyCode: 229 }) })
    expect(selected).toEqual([])
    expect(closed).toBe(0)
    await act(async () => { pressKey(field!, 'Enter', { keyCode: 13 }) })
    expect(selected).toEqual(['demo'])
    await view.unmount()
  })

  it('does not choose or close the model picker', async () => {
    const option: ModelOption = { model: 'local-small', provider: 'local', providerName: 'Local' }
    const selected: string[] = []
    let closed = 0
    const view = await mounted(createElement(ModelPicker, {
      options: [option],
      current: option.model,
      profileModel: option.model,
      loading: false,
      error: '',
      initialQuery: '',
      onSelect: (item) => { selected.push(item.model) },
      onClose: () => { closed += 1 },
      onManage: () => undefined,
    }))
    const field = fieldByLabel(view.container, 'Rechercher un modèle')
    expect(field).not.toBeNull()
    await act(async () => { pressKey(field!, 'Enter', { isComposing: true }) })
    await act(async () => { pressKey(field!, 'Enter', { keyCode: 229 }) })
    expect(selected).toEqual([])
    expect(closed).toBe(0)
    await act(async () => { pressKey(field!, 'Enter', { keyCode: 13 }) })
    expect(closed).toBe(1)
    expect(selected).toEqual([])
    await view.unmount()
  })

  it('does not step the find match', async () => {
    const message: ChatMessage = { id: 'm', role: 'user', content: 'alpha beta', createdAt: '2026-11-16T00:00:00.000Z' }
    const view = await mounted(createElement(ChatView, {
      bot: bot(),
      bots: [],
      messages: [message],
      streaming: '',
      streamKey: '',
      running: true,
      activity: '',
      workText: '',
      loading: false,
      detailsOpen: false,
      focusSignal: 0,
      onOpenMobile: () => undefined,
      onToggleDetails: () => undefined,
      onSend: () => true,
      onStop: () => undefined,
      onNotice: () => undefined,
      onOpenDocument: () => undefined,
      onOpenBot: () => undefined,
      modelLabel: 'local',
      onOpenModels: () => undefined,
      usage: null,
      showUsage: false,
      onToggleUsage: () => undefined,
      prompts: [],
      onAnswerPrompt: async () => undefined,
      subagents: [],
      processes: 0,
      onLoadSubagentTail: async () => ({ available: false, text: '', truncated: false }),
      onOpenSubagentHistory: () => undefined,
    }))
    expect(view.container.querySelector('.composer-hint-keys')).toBeNull()
    expect(walkElements(view.container, (element) => element.getAttribute('aria-label') === 'Arrêter le bot')).not.toBeNull()
    const open = walkElements(view.container, (element) => element.getAttribute('aria-label') === 'Rechercher dans la conversation')
    await act(async () => { open?.click() })
    const field = fieldByLabel(view.container, 'Texte à rechercher')
    expect(field).not.toBeNull()
    await act(async () => { typeInto(field!, 'alpha') })
    const count = () => view.container.querySelector('.chat-search-count')?.textContent ?? ''
    expect(count()).not.toContain('/')
    await act(async () => { pressKey(field!, 'Enter', { isComposing: true }) })
    await act(async () => { pressKey(field!, 'Enter', { keyCode: 229 }) })
    expect(count()).not.toContain('/')
    await act(async () => { pressKey(field!, 'Enter', { keyCode: 13 }) })
    expect(count()).toBe('1 / 1')
    await view.unmount()
  })
})

describe('composer hint', () => {
  it('draws no help sentence under the field while a turn is running', async () => {
    const view = await mounted(createElement(Composer, {
      bot: bot(),
      bots: [],
      running: true,
      disabled: false,
      focusSignal: 0,
      onSend: () => true,
      onStop: () => undefined,
      onNotice: () => undefined,
      modelLabel: 'local',
      onOpenModels: () => undefined,
      usage: null,
      showUsage: false,
      onToggleUsage: () => undefined,
    }))
    expect(view.container.querySelector('.composer-hint-keys')).toBeNull()
    expect(view.container.textContent).not.toContain('composer.hintWait')
    expect(walkElements(view.container, (element) => element.getAttribute('aria-label') === 'Arrêter le bot')).not.toBeNull()
    await view.unmount()
  })
})
