import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { installTestDom } from '../components/test-dom'
import { useLiveRuntime } from './useLiveRuntime'
import { resolveDelegateTargetModel } from './useDelegateController'
import { AUTO_MODEL_SENTINEL } from '../lib/auto-router'
import type { ModelOption } from '../types'

describe('resolveDelegateTargetModel', () => {
  const options: ModelOption[] = [
    { model: 'openai/gpt-5', provider: 'openai', providerName: 'OpenAI' },
    { model: 'cursor/grok-4.7', provider: 'cursor', providerName: 'Cursor' },
    { model: 'hermesbot:delegate', provider: 'bot', providerName: 'Bot' },
    { model: AUTO_MODEL_SENTINEL, provider: '', providerName: 'Auto' },
  ]

  it('keeps a concrete selected model', () => {
    const r = resolveDelegateTargetModel('openai/gpt-5', 'cursor/grok-4.7', 'cursor/grok-4.7', options, 'cursor')
    expect(r.model).toBe('openai/gpt-5')
    expect(r.provider).toBe('openai')
  })

  it('falls back to sessionModel when the picker is Auto or the sentinel delegate', () => {
    expect(resolveDelegateTargetModel(AUTO_MODEL_SENTINEL, 'openai/gpt-5', 'cursor/grok-4.7', options, 'cursor').model).toBe('openai/gpt-5')
    expect(resolveDelegateTargetModel('hermesbot:delegate', 'openai/gpt-5', 'cursor/grok-4.7', options, 'cursor').model).toBe('openai/gpt-5')
    expect(resolveDelegateTargetModel('hermesbot:delegate', undefined, 'cursor/grok-4.7', options, 'cursor').model).toBe('cursor/grok-4.7')
  })

  it('resolves provider from modelOptions and falls back to botProvider for the bot model', () => {
    const r = resolveDelegateTargetModel(AUTO_MODEL_SENTINEL, undefined, 'cursor/grok-4.7', options, 'cursor')
    expect(r.provider).toBe('cursor')
    const botOnly = resolveDelegateTargetModel(AUTO_MODEL_SENTINEL, undefined, 'custom/model', [{ model: 'custom/model', provider: '', providerName: '' }], 'custom-provider')
    expect(botOnly.provider).toBe('custom-provider')
  })
})

describe('useLiveRuntime', () => {
  it('tracks message.start -> runtime.now -> message.complete and resets on profile change', async () => {
    const { container } = installTestDom()
    const root = createRoot(container as unknown as Element)
    const apiRef: { current: ReturnType<typeof useLiveRuntime> | null } = { current: null }
    function Probe({ profile, sessionId }: { profile: string; sessionId: string }) {
      const api = useLiveRuntime(profile, sessionId)
      apiRef.current = api
      return createElement('div', null, api.liveRuntime ? api.liveRuntime.role : 'none')
    }
    await act(async () => { root.render(createElement(Probe, { profile: 'nova', sessionId: 's1' })) })
    expect(container.textContent).toBe('none')

    await act(async () => { apiRef.current!.applyRuntimeEvent('nova', { type: 'message.start', payload: {} }, undefined, true) })
    expect(apiRef.current!.liveRuntime?.pending).toBe(true)
    expect(apiRef.current!.liveRuntime?.role).toBe('chat')

    await act(async () => { apiRef.current!.applyRuntimeEvent('nova', { type: 'runtime.now', payload: { role: 'worker', model: 'cursor/grok-4.7', provider: 'cursor' } }, undefined, true) })
    expect(apiRef.current!.liveRuntime?.role).toBe('worker')
    expect(apiRef.current!.liveRuntime?.model).toBe('cursor/grok-4.7')
    expect(apiRef.current!.liveRuntime?.pending).toBe(false)
    expect(apiRef.current!.getRuntime('nova')?.role).toBe('worker')

    await act(async () => { apiRef.current!.applyRuntimeEvent('nova', { type: 'message.complete', payload: {} }, undefined, true) })
    expect(apiRef.current!.liveRuntime?.pending).toBe(false)

    await act(async () => { root.render(createElement(Probe, { profile: 'inkling', sessionId: 's2' })) })
    expect(apiRef.current!.liveRuntime).toBeNull()
    expect(apiRef.current!.getRuntime('nova')?.role).toBe('worker')
    expect(apiRef.current!.getRuntime('inkling')).toBeNull()

    await act(async () => { apiRef.current!.clearRuntime('nova', false) })
    expect(apiRef.current!.getRuntime('nova')).toBeNull()

    await act(async () => { root.unmount() })
  })
})
