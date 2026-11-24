import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelOption } from '../types'
import { decideAutoRoute } from './auto-router'
import type { ActiveChat, HermesClient } from './hermes'
import { beginAutoRoutedTurn, submitAutoTurn, type AutoTurnTrack, type RoutedTurnPlan, isRetryableTurnComplete, turnFallbackError } from './auto-route-turn'

vi.mock('./auto-router', async () => {
  const actual = await vi.importActual<typeof import('./auto-router')>('./auto-router')
  return { ...actual, decideAutoRoute: vi.fn() }
})

const chat: ActiveChat = { profile: 'lea', sessionId: 's1', revision: 1, executionGeneration: 1, running: false, socketGeneration: 1, model: 'kimi-for-coding' }
const models: ModelOption[] = [
  { provider: 'anthropic', model: 'claude-sonnet-5-5', providerName: 'Anthropic' },
  { provider: 'kimi-coding', model: 'kimi-for-coding', providerName: 'Kimi' },
]

function fakeClient(request: (method: string, params?: Record<string, unknown>) => Promise<unknown>) {
  return { request } as unknown as HermesClient
}

describe('auto route in-turn errors', () => {
  it('detects retryable provider completions', () => {
    expect(isRetryableTurnComplete({ status: 'error', error: { code: 'rate_limit_exceeded', message: '429' } })).toBe(true)
    expect(isRetryableTurnComplete({ status: 'error', error: { message: '402 payment required' } })).toBe(true)
    expect(isRetryableTurnComplete({ status: 'error', error: { message: '410 end of life' } })).toBe(true)
    expect(isRetryableTurnComplete({ status: 'error', text: 'every provider in the fallback chain kept failing over' })).toBe(true)
    expect(isRetryableTurnComplete({ status: 'complete', text: 'ok' })).toBe(false)
    expect(isRetryableTurnComplete({ status: 'error', text: 'provider unavailable' })).toBe(true)
  })

  it('formats fallback error labels', () => {
    expect(turnFallbackError({ error: { code: 'rate_limit' } })).toBe('429')
    expect(turnFallbackError({ error: { message: 'upstream refused' } })).toBe('error:upstream refused')
  })
})

describe('auto routed submit', () => {
  beforeEach(() => {
    vi.mocked(decideAutoRoute).mockReset()
  })

  it('plans the turn, confirms the model switch, and compacts when the window cannot hold it', async () => {
    vi.mocked(decideAutoRoute).mockResolvedValue({
      ok: true,
      mode: 'auto',
      category: 'writing',
      chosen: 'anthropic/claude-sonnet-5-5',
      label: 'Sonnet 5.5',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      reason: 'best for writing',
      needsCompaction: true,
      fallbacks: [],
    })
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      const payload = params?.payload as { confirm?: string; model?: string } | undefined
      if (method === 'session.mutate' && !payload?.confirm) return { status: 'confirmation_required', confirm: 'yes' }
      if (method === 'session.mutate') return { revision: 4, execution_generation: 2, model: payload?.model }
      return {}
    })
    const compact = vi.fn(async () => true)
    const begun = await beginAutoRoutedTurn({
      client: fakeClient(request),
      chat,
      text: 'New bot: introduce yourself',
      imageCount: 0,
      usage: null,
      modelOptions: models,
      analyticsProfiles: ['lea'],
      mode: 'auto',
      onModelApplied: () => undefined,
      compactIfNeeded: compact,
    })
    expect(request.mock.calls.map(([method]) => method)).toEqual(['session.mutate', 'session.mutate'])
    expect(begun.plan.badge).toMatchObject({ mode: 'auto', category: 'writing', chosen: 'anthropic/claude-sonnet-5-5', label: 'Sonnet 5.5', reason: 'best for writing' })
    expect(begun.chat).toMatchObject({ model: 'claude-sonnet-5-5', revision: 4, executionGeneration: 2 })
    expect(compact).toHaveBeenCalledWith(begun.chat)
    expect(decideAutoRoute).toHaveBeenCalledWith(expect.objectContaining({ bot: 'lea', sessionId: 's1', text: 'New bot: introduce yourself', mode: 'auto' }))
  })

  it('submits once and keeps no track when Auto is off', async () => {
    const submit = vi.fn(async (next: ActiveChat) => next)
    const remember = vi.fn()
    const submitted = await submitAutoTurn({
      client: fakeClient(vi.fn()),
      chat,
      plan: null,
      prompt: 'hello',
      apiText: 'hello',
      images: [],
      userMessageId: 'u1',
      submit,
      onModelApplied: () => undefined,
      onBadge: () => undefined,
      remember,
    })
    expect(submitted).toBe(chat)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(remember).not.toHaveBeenCalled()
  })

  it('records quota errors and walks the fallback queue on a retryable provider error', async () => {
    const plan: RoutedTurnPlan = {
      mode: 'auto',
      option: { provider: 'anthropic', model: 'claude-sonnet-5-5', providerName: 'anthropic' },
      decision: {
        ok: true,
        fallbacks: [{ provider: 'kimi-coding', model: 'kimi-for-coding', fullId: 'kimi-coding/kimi-for-coding', label: 'Kimi K2.8', score: 1 }],
      },
      fallbackQueue: [{ provider: 'kimi-coding', model: 'kimi-for-coding', providerName: 'kimi-coding' }],
      badge: { mode: 'auto', category: 'writing', chosen: 'anthropic/claude-sonnet-5-5', label: 'Sonnet', reason: 'writing' },
    }
    const request = vi.fn(async () => ({ revision: 5, execution_generation: 1 }))
    let submits = 0
    const submit = vi.fn(async (next: ActiveChat) => {
      submits += 1
      if (submits === 1) throw new Error('429 rate limit')
      return next
    })
    const badges: string[] = []
    let track: AutoTurnTrack | undefined
    const submitted = await submitAutoTurn({
      client: fakeClient(request),
      chat,
      plan,
      prompt: 'New bot: introduce yourself',
      apiText: 'instruction',
      images: [],
      userMessageId: 'kickoff-1',
      submit,
      onModelApplied: () => undefined,
      onBadge: (badge) => badges.push(badge.chosen),
      remember: (value) => { track = value },
    })
    expect(submit).toHaveBeenCalledTimes(2)
    expect(badges).toEqual(['kimi-coding/kimi-for-coding'])
    expect(track?.userMessageId).toBe('kickoff-1')
    expect(track?.quotaErrors).toEqual([expect.objectContaining({ model: 'anthropic/claude-sonnet-5-5', status: 429 })])
    expect(track?.fallbacks).toEqual([{ model: 'kimi-coding/kimi-for-coding', error: '429' }])
    expect(track?.plan.badge.label).toBe('Kimi K2.8')
    expect(track?.chat.model).toBe('kimi-for-coding')
    expect(submitted.model).toBe('kimi-for-coding')
    expect(request).toHaveBeenCalledWith('session.mutate', expect.objectContaining({
      operation: 'model',
      payload: expect.objectContaining({ model: 'kimi-for-coding', provider: 'kimi-coding' }),
    }))
  })

  it('does not switch model when the provider error is not retryable', async () => {
    const plan: RoutedTurnPlan = {
      mode: 'auto',
      option: { provider: 'anthropic', model: 'claude-sonnet-5-5', providerName: 'anthropic' },
      decision: { ok: true, fallbacks: [{ provider: 'kimi-coding', model: 'kimi-for-coding', fullId: 'kimi-coding/kimi-for-coding', score: 1 }] },
      fallbackQueue: [{ provider: 'kimi-coding', model: 'kimi-for-coding', providerName: 'kimi-coding' }],
      badge: { mode: 'auto', category: 'other', chosen: 'anthropic/claude-sonnet-5-5', reason: 'Auto' },
    }
    const request = vi.fn()
    const submit = vi.fn(async () => { throw new Error('permission_denied') })
    await expect(submitAutoTurn({
      client: fakeClient(request),
      chat,
      plan,
      prompt: 'hello',
      images: [],
      userMessageId: 'u1',
      submit,
      onModelApplied: () => undefined,
      onBadge: () => undefined,
      remember: () => undefined,
    })).rejects.toThrow('permission_denied')
    expect(submit).toHaveBeenCalledTimes(1)
    expect(request).not.toHaveBeenCalled()
  })

  it('loads an empty catalog before it asks Auto to pick', async () => {
    vi.mocked(decideAutoRoute).mockResolvedValue({
      ok: true,
      mode: 'auto',
      category: 'quick',
      chosen: 'anthropic/claude-sonnet-5-5',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      reason: 'quick',
      fallbacks: [],
    })
    const request = vi.fn(async () => ({ revision: 2, execution_generation: 1 }))
    const loadModels = vi.fn(async () => models)
    const begun = await beginAutoRoutedTurn({
      client: fakeClient(request),
      chat,
      text: 'Test animation',
      imageCount: 0,
      usage: null,
      modelOptions: [],
      loadModels,
      mode: 'auto',
      onModelApplied: () => undefined,
    })
    expect(loadModels).toHaveBeenCalledTimes(1)
    expect(decideAutoRoute).toHaveBeenCalledWith(expect.objectContaining({
      models: [expect.objectContaining({ model: 'claude-sonnet-5-5' }), expect.objectContaining({ model: 'kimi-for-coding' })],
    }))
    expect(begun.plan.fellBack).toBeFalsy()
    expect(begun.chat.model).toBe('claude-sonnet-5-5')
    expect(request).toHaveBeenCalled()
  })

  it('sends on the session model when the catalog does not arrive in time', async () => {
    let release: (value: ModelOption[]) => void = () => undefined
    const loadModels = () => new Promise<ModelOption[]>((resolve) => { release = resolve })
    const request = vi.fn()
    const begun = await beginAutoRoutedTurn({
      client: fakeClient(request),
      chat,
      text: 'Test animation',
      imageCount: 0,
      usage: null,
      modelOptions: [],
      loadModels,
      catalogWaitMs: 20,
      mode: 'auto',
      onModelApplied: () => undefined,
    })
    release([])
    expect(begun.plan.fellBack).toBe(true)
    expect(begun.plan.badge.fellBack).toBe(true)
    expect(begun.plan.badge.reason).toBe('catalog_unavailable')
    expect(begun.plan.badge.chosen).toBe('kimi-for-coding')
    expect(begun.chat).toBe(chat)
    expect(request).not.toHaveBeenCalled()
    expect(decideAutoRoute).not.toHaveBeenCalled()
  })

  it('sends on the session model when Auto cannot pick', async () => {
    vi.mocked(decideAutoRoute).mockResolvedValue({ ok: false, error: 'quota_exhausted' })
    const request = vi.fn()
    const begun = await beginAutoRoutedTurn({
      client: fakeClient(request),
      chat,
      text: 'hello',
      imageCount: 0,
      usage: null,
      modelOptions: models,
      mode: 'auto',
      onModelApplied: () => undefined,
    })
    expect(begun.plan.fellBack).toBe(true)
    expect(begun.plan.badge.reason).toBe('quota_exhausted')
    expect(begun.plan.badge.chosen).toBe('kimi-coding/kimi-for-coding')
    expect(begun.chat.model).toBe('kimi-for-coding')
    expect(request).not.toHaveBeenCalled()
  })

  it('sends on the session model when the router errors', async () => {
    vi.mocked(decideAutoRoute).mockRejectedValue(new Error('router_down'))
    const begun = await beginAutoRoutedTurn({
      client: fakeClient(vi.fn()),
      chat,
      text: 'hello',
      imageCount: 0,
      usage: null,
      modelOptions: models,
      mode: 'auto',
      onModelApplied: () => undefined,
    })
    expect(begun.plan.fellBack).toBe(true)
    expect(begun.plan.badge.reason).toBe('router_down')
    expect(begun.chat).toBe(chat)
  })
})