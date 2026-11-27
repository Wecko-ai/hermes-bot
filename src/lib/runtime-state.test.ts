import { describe, expect, it } from 'vitest'
import type { SessionUsage } from '../types'
import { effectiveContextUsage, isStaleOmlxProvider, parseRuntimeEvent, reduceLiveRuntime, sameModelId } from './runtime-state'

const USAGE: SessionUsage = {
  contextUsed: 272_000,
  contextMax: 1_048_576,
  contextPercent: 26,
  averageTps: 40,
  inputTokens: 100,
  outputTokens: 50,
  totalTokens: 150,
  model: 'kimi/k3.1-pro',
  provider: 'kimi',
}

describe('sameModelId', () => {
  it('matches case-insensitively and with custom: prefix and provider suffix', () => {
    expect(sameModelId('cursor/grok-4.7', 'Cursor/Grok-4.7')).toBe(true)
    expect(sameModelId('custom:kimi/kimi-k3', 'kimi/kimi-k3')).toBe(true)
    expect(sameModelId('kimi/kimi-k3-pro', 'kimi/kimi-k3-pro')).toBe(true)
    expect(sameModelId('kimi/kimi-k3-pro', 'cursor/kimi-k3-pro')).toBe(true)
    expect(sameModelId('kimi/kimi-k3', 'cursor/grok')).toBe(false)
    expect(sameModelId(undefined, undefined)).toBe(true)
  })
})

describe('isStaleOmlxProvider', () => {
  it('flags omlx without indistinguishable markers', () => {
    expect(isStaleOmlxProvider('omlx', 'kimi-for-coding')).toBe(true)
    expect(isStaleOmlxProvider('custom:omlx', 'some-model')).toBe(true)
    expect(isStaleOmlxProvider('omlx', 'inkling-8B-mlx')).toBe(false)
    expect(isStaleOmlxProvider('omlx', 'jundot-gguf')).toBe(false)
    expect(isStaleOmlxProvider('omlx', 'qwen3.8-4B')).toBe(false)
    expect(isStaleOmlxProvider('omlx', '')).toBe(false)
    expect(isStaleOmlxProvider('cursor', 'anything')).toBe(false)
  })
})

describe('reduceLiveRuntime', () => {
  it('message.start creates a pending chat state', () => {
    const state = reduceLiveRuntime(null, { type: 'message.start', payload: {} })
    expect(state?.pending).toBe(true)
    expect(state?.role).toBe('chat')
    expect(effectiveContextUsage(USAGE, state, { running: true, fresh: false, answered: null })).toBeNull()
  })

  it('runtime.now chef with a running worker mission hands off to worker scope, then back to chef window', () => {
    let state = reduceLiveRuntime(null, { type: 'message.start', payload: {} })!
    state = reduceLiveRuntime(state, {
      type: 'runtime.now',
      payload: {
        role: 'chef',
        model: 'cursor/grok-4.7',
        provider: 'cursor',
        mission: { id: 'm1', slot: 0, status: 'running', workerModel: 'kimi/k3.1-pro', workerLabel: 'Worker', contextUsed: 24_000, contextMax: 131_072, tps: 12 },
      },
    })!
    expect(state.pending).toBe(false)
    const workerUsage = effectiveContextUsage(USAGE, state, { running: true, fresh: true, answered: null })
    expect(workerUsage?.scope).toBe('worker')
    expect(workerUsage?.contextMax).toBe(131_072)
    expect(workerUsage?.contextUsed).toBe(24_000)
    expect(workerUsage?.model).toBe('kimi/k3.1-pro')

    // mission completes -> chef window shown again (chef frame: 1M window)
    state = reduceLiveRuntime(state, { type: 'runtime.now', payload: { mission: { id: 'm1', slot: 0, status: 'completed', contextUsed: 24_000, contextMax: 131_072 } } })!
    expect(state.mission?.status).toBe('completed')
    const chefFrame: SessionUsage = { ...USAGE, model: 'cursor/grok-4.7', provider: 'cursor', contextUsed: 300_000, contextMax: 1_048_576, contextPercent: 29 }
    const chefUsage = effectiveContextUsage(chefFrame, state, { running: false, fresh: true, answered: null })
    expect(chefUsage?.scope).toBe('turn')
    expect(chefUsage?.contextMax).toBe(1_048_576)
    expect(chefUsage?.model).toBe('cursor/grok-4.7')
  })

  it('session.usage with a running worker mission does not clobber worker identity', () => {
    let state = reduceLiveRuntime(null, { type: 'message.start', payload: {} })!
    state = reduceLiveRuntime(state, {
      type: 'runtime.now',
      payload: { role: 'worker', model: 'kimi/k3.1-pro', provider: 'kimi', mission: { id: 'm1', slot: 0, status: 'running', workerModel: 'kimi/k3.1-pro', contextUsed: 10_000, contextMax: 131_072 } },
    })!
    state = reduceLiveRuntime(state, { type: 'session.usage', payload: { model: 'kimi/k3.1-pro', provider: 'kimi', context_used: 20_000, context_max: 131_072, avg_tps: 9 } })!
    expect(state.role).toBe('worker')
    expect(state.mission?.status).toBe('running')
    expect(state.contextUsed).toBeUndefined()
  })

  it('worker_down_normal + Kimi usage under an Inkling picker: runtime wins, composer readout alone is null', () => {
    const picker = 'inkling/inkling-1.2'
    const usage = { ...USAGE, model: 'kimi/kimi-k3', provider: 'kimi', contextUsed: 272_000, contextMax: 1_048_576 }
    let state = reduceLiveRuntime(null, { type: 'message.start', payload: {} })!
    state = reduceLiveRuntime(state, {
      type: 'runtime.now',
      payload: { role: 'normal_after_worker_down', model: 'kimi/kimi-k3', provider: 'kimi', contextUsed: 272_000, contextMax: 1_048_576 },
    })!
    const runtimeUsage = effectiveContextUsage(usage, state, { running: false, fresh: true, answered: null, selectedModel: picker })
    expect(runtimeUsage?.scope).toBe('turn')
    expect(runtimeUsage?.model).toBe('kimi/kimi-k3')
    expect(runtimeUsage?.contextMax).toBe(1_048_576)

    const noRuntime = effectiveContextUsage(usage, null, { running: true, fresh: true, answered: null, selectedModel: picker })
    expect(noRuntime).toBeNull()

    // resting (e.g. just after a manual session.compress compaction): usage stays shown
    const resting = effectiveContextUsage(usage, null, { running: false, fresh: true, answered: null, selectedModel: picker })
    expect(resting?.scope).toBe('turn')
    expect(resting?.model).toBe('kimi/kimi-k3')
    expect(resting?.contextMax).toBe(1_048_576)
  })

  it('vision transient with retry attempt: 2 of 3', () => {
    let state = reduceLiveRuntime(null, { type: 'message.start', payload: {} })!
    state = reduceLiveRuntime(state, { type: 'runtime.now', payload: { role: 'vision', model: 'vision/model', attempt: 2, maxAttempts: 3 } })!
    expect(state.role).toBe('vision')
    expect(state.attempt).toBe(2)
    expect(state.maxAttempts).toBe(3)
    // stale frame without attempt: cleans attempt
    state = reduceLiveRuntime(state, { type: 'runtime.now', payload: { role: 'vision', model: 'vision/model' } })!
    expect(state.attempt).toBeUndefined()
    expect(state.maxAttempts).toBeUndefined()
  })

  it('status.update fallback masks the old gauge until the new model frame arrives', () => {
    let state = reduceLiveRuntime(null, { type: 'message.start', payload: {} })!
    state = reduceLiveRuntime(state, {
      type: 'runtime.now',
      payload: { role: 'chat', model: 'inkling/inkling-1.2', provider: 'inkling', contextUsed: 50_000, contextMax: 100_000 },
    })!
    expect(effectiveContextUsage(USAGE, state, { running: true, fresh: true, answered: null })?.contextMax).toBe(100_000)

    state = reduceLiveRuntime(state, {
      type: 'status.update',
      payload: { text: '⚠️ Model fallback: inkling/inkling-1.2 via inkling unavailable (rate limit); using cursor/composer-2.5 via cursor.' },
    })!
    expect(state.role).toBe('fallback')
    expect(state.pending).toBe(true)
    expect(state.model).toBe('cursor/composer-2.5')
    expect(state.previous?.model).toBe('inkling/inkling-1.2')
    expect(effectiveContextUsage(USAGE, state, { running: true, fresh: true, answered: null })).toBeNull()
  })

  it('stale omlx provider is filtered from runtime frames', () => {
    const parsed = parseRuntimeEvent({ role: 'chat', model: 'kimi-for-coding', provider: 'omlx' })
    expect(parsed?.provider).toBe('')
    expect(parsed?.model).toBe('kimi-for-coding')
  })

  it('message.complete ends a running mission and clears pending', () => {
    let state = reduceLiveRuntime(null, { type: 'message.start', payload: {} })!
    state = reduceLiveRuntime(state, {
      type: 'runtime.now',
      payload: { role: 'worker', model: 'kimi/k3.1-pro', mission: { id: 'm1', slot: 0, status: 'running', workerModel: 'kimi/k3.1-pro', contextUsed: 1, contextMax: 100 } },
    })!
    state = reduceLiveRuntime(state, { type: 'message.complete', payload: {} })!
    expect(state?.pending).toBe(false)
    expect(state?.mission?.status).toBe('completed')
  })
})

describe('compaction regression', () => {
  it('session.usage stops masking the compacted usage store', () => {
    let state = reduceLiveRuntime(null, { type: 'message.start', payload: {} })!
    state = reduceLiveRuntime(state, { type: 'session.usage', payload: { model: 'kimi/k3.1-pro', provider: 'kimi', context_used: 460_000, context_max: 1_000_000, avg_tps: 30 } })!
    const compactedUsage: SessionUsage = { ...USAGE, contextUsed: 120_000, contextMax: 1_000_000, model: 'kimi/k3.1-pro', provider: 'kimi' }
    const out = effectiveContextUsage(compactedUsage, state, { running: false, fresh: true, answered: null })
    expect(out?.contextUsed).toBe(120_000)
    expect(out?.contextMax).toBe(1_000_000)
  })

  it('runtime.now without context fields does not keep the previous model window', () => {
    let state = reduceLiveRuntime(null, { type: 'message.start', payload: {} })!
    state = reduceLiveRuntime(state, { type: 'runtime.now', payload: { role: 'chat', model: 'kimi/k3.1-pro', contextUsed: 272_000, contextMax: 1_048_576 } })!
    state = reduceLiveRuntime(state, { type: 'runtime.now', payload: { role: 'chat', model: 'claude-sonnet-5-5' } })!
    expect(state?.contextUsed).toBeUndefined()
    expect(state?.contextMax).toBeUndefined()
    expect(state?.tps).toBeUndefined()
  })
})
