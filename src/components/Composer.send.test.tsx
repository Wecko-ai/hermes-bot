import './test-dom'
import { createElement, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, expect, it } from 'vitest'
import type { Bot } from '../types'
import { Composer, type ComposerHandle } from './Composer'
import { fieldByLabel, installTestDom, pressKey, typeInto, walkElements } from './test-dom'

if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(callback, 0) as unknown as number
}

const bot = (): Bot => ({
  slug: 'demo', name: 'Alpha', role: 'Helper', section: 'Team', sectionId: 'team', model: 'local-small',
  status: 'idle', preview: '', timestamp: null, unread: 0, hidden: false,
})

const sendButton = (root: Parameters<typeof walkElements>[0]) =>
  walkElements(root, (element) => element.getAttribute('aria-label') === 'Envoyer')

async function mount(onSend: (...args: unknown[]) => boolean | Promise<boolean>) {
  const { container } = installTestDom()
  const root = createRoot(container as unknown as Element)
  const handle = createRef<ComposerHandle>()
  await act(async () => {
    root.render(createElement(Composer, {
      ref: handle,
      bot: bot(),
      bots: [],
      running: false,
      disabled: false,
      focusSignal: 0,
      onSend: onSend as never,
      onStop: () => undefined,
      onNotice: () => undefined,
      onOpenModels: () => undefined,
    }))
  })
  const field = () => fieldByLabel(container, 'Message à Alpha')
  return {
    container,
    handle,
    field,
    unmount: () => act(async () => { root.unmount() }),
  }
}

describe('composer send button', () => {
  it('does not render model selector or usage controls in the composer', async () => {
    const view = await mount(() => true)
    expect(view.container.querySelector('.model-chip')).toBeNull()
    expect(view.container.querySelector('.usage-toggle')).toBeNull()
    expect(view.container.querySelector('.usage-readout')).toBeNull()
    expect(view.container.querySelector('.composer-status')).toBeNull()
    await view.unmount()
  })

  it('stays hidden while the field is empty or only whitespace', async () => {
    const view = await mount(() => true)
    expect(sendButton(view.container)).toBeNull()
    await act(async () => { typeInto(view.field()!, '   \n  ') })
    expect(sendButton(view.container)).toBeNull()
    await view.unmount()
  })

  it('hides the arrow as soon as the message is sent, and shows it again when new text is typed', async () => {
    let release: (sent: boolean) => void = () => undefined
    const pending = new Promise<boolean>((resolve) => { release = resolve })
    const sent: string[] = []
    const view = await mount((text) => { sent.push(String(text)); return pending })
    await act(async () => { typeInto(view.field()!, 'bonjour') })
    expect(sendButton(view.container)).not.toBeNull()
    await act(async () => { view.handle.current?.addFiles([new File(['note'], 'note.txt', { type: 'text/plain' })]) })
    expect(view.container.querySelector('.composer-file')).not.toBeNull()
    await act(async () => { pressKey(view.field()!, 'Enter') })
    expect(sent).toEqual(['bonjour'])
    expect(view.field()!.value).toBe('')
    expect(view.container.querySelector('.composer-file')).toBeNull()
    expect(sendButton(view.container)).toBeNull()
    await act(async () => { typeInto(view.field()!, 'encore') })
    expect(sendButton(view.container)).not.toBeNull()
    expect(view.field()!.value).toBe('encore')
    await act(async () => { release(false) })
    expect(view.field()!.value).toBe('encore')
    await view.unmount()
  })

  it('sends once when Enter and the button fire together', async () => {
    let release: (sent: boolean) => void = () => undefined
    const pending = new Promise<boolean>((resolve) => { release = resolve })
    let calls = 0
    const view = await mount(() => { calls += 1; return pending })
    await act(async () => { typeInto(view.field()!, 'une fois') })
    await act(async () => {
      pressKey(view.field()!, 'Enter')
      pressKey(view.field()!, 'Enter')
      ;(sendButton(view.container) as { click: () => void } | null)?.click()
    })
    expect(calls).toBe(1)
    await act(async () => { release(true) })
    await view.unmount()
  })

  it('keeps the same client id when the failed send is tried again', async () => {
    const ids: string[] = []
    const view = await mount((_text, _attachments, _mode, _delivery, submissionId) => {
      ids.push(String(submissionId))
      return false
    })
    await act(async () => { typeInto(view.field()!, 'bonjour') })
    await act(async () => { pressKey(view.field()!, 'Enter') })
    expect(view.field()!.value).toBe('bonjour')
    expect(sendButton(view.container)).not.toBeNull()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 420)) })
    await act(async () => { pressKey(view.field()!, 'Enter') })
    expect(ids).toHaveLength(2)
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/)
    expect(ids[1]).toBe(ids[0])
    await view.unmount()
  })
})
