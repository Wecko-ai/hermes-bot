import { afterEach, describe, expect, it, vi } from 'vitest'
import { CATEGORIES } from './classifier.mjs'
import {
  botEnabled,
  checkLocalAvailable,
  clipForTriage,
  parseTriageResponse,
  resolveCategory,
  weightsForDifficulty,
} from './triage.mjs'

const live = {
  mode: 'live',
  enabledBots: ['orion', 'nova'],
  endpoint: 'http://127.0.0.1:8000/v1/chat/completions',
  modelsUrl: 'http://127.0.0.1:8000/admin/api/models',
  model: 'mlx-community--Qwen3.5-9B-4bit',
  timeoutMs: 1500,
  availableTimeoutMs: 300,
  maxInputTokens: 2000,
  confidenceThreshold: 0.7,
  maxTokens: 64,
}

describe('triage helpers', () => {
  it('parses JSON even when wrapped in think tags or prose', () => {
    expect(parseTriageResponse('<think>hmm</think>{"category":"research","difficulty":"hard"}')).toEqual({
      category: 'research', difficulty: 'hard',
    })
    expect(parseTriageResponse('Here you go:\n```json\n{"category":"writing","difficulty":"easy"}\n```')).toEqual({
      category: 'writing', difficulty: 'easy',
    })
    expect(parseTriageResponse('{"category":"nope","difficulty":"hard"}')).toBeNull()
    expect(parseTriageResponse('{"category":"coding"}').difficulty).toBe('medium')
  })

  it('clips long input under the token budget and keeps both ends', () => {
    const long = `START ${'x'.repeat(20_000)} END-MARKER`
    const clipped = clipForTriage(long, 'short summary', 2000)
    expect(clipped.text.startsWith('START')).toBe(true)
    expect(clipped.text.includes('END-MARKER')).toBe(true)
    expect(clipped.text.length).toBeLessThan(long.length)
    expect(clipped.summary).toBe('short summary')
  })

  it('enables only the listed bots', () => {
    expect(botEnabled('orion', live)).toBe(true)
    expect(botEnabled('Orion', live)).toBe(true)
    expect(botEnabled('vega', live)).toBe(false)
    expect(botEnabled('', live)).toBe(false)
  })

  it('tilts weights for hard and easy work', () => {
    expect(weightsForDifficulty('hard').quality).toBeGreaterThan(1)
    expect(weightsForDifficulty('easy').latency).toBeGreaterThan(0.15)
    expect(weightsForDifficulty('medium')).toEqual({})
  })
})

describe('resolveCategory', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps high-confidence rules without calling the model', async () => {
    const callLocal = vi.fn()
    const result = await resolveCategory(
      { text: '```ts\nconst x = 1\n```', bot: 'orion' },
      live,
      { callLocal, checkAvailable: vi.fn() },
    )
    expect(result.source).toBe('rules')
    expect(result.category).toBe('coding')
    expect(result.skipReason).toBe('high_confidence')
    expect(callLocal).not.toHaveBeenCalled()
  })

  it('does not call the model for a bot that is not enabled', async () => {
    const callLocal = vi.fn()
    const result = await resolveCategory(
      { text: 'The quarterly report attachments are in the shared drive folder marked Q3 — please reconcile the ledger with finance before the board packet ships next month.', bot: 'vega' },
      live,
      { callLocal, checkAvailable: vi.fn() },
    )
    expect(result.source).toBe('rules')
    expect(result.skipReason).toBe('bot_disabled')
    expect(callLocal).not.toHaveBeenCalled()
  })

  it('uses the local category in live mode when confidence is low', async () => {
    const result = await resolveCategory(
      { text: 'The quarterly report attachments are in the shared drive folder marked Q3 — please reconcile the ledger with finance before the board packet ships next month.', bot: 'orion' },
      live,
      {
        checkAvailable: async () => ({ ok: true, reason: null, loaded: true }),
        callLocal: async () => ({ ok: true, category: 'writing', difficulty: 'hard', latencyMs: 120 }),
      },
    )
    expect(result.source).toBe('local')
    expect(result.category).toBe('writing')
    expect(result.rulesCategory).toBe('other')
    expect(result.difficulty).toBe('hard')
    expect(result.latencyMs).toBe(120)
  })

  it('keeps the rules category in shadow mode but records the local label', async () => {
    const result = await resolveCategory(
      { text: 'The quarterly report attachments are in the shared drive folder marked Q3 — please reconcile the ledger with finance before the board packet ships next month.', bot: 'orion' },
      { ...live, mode: 'shadow' },
      {
        checkAvailable: async () => ({ ok: true, reason: null, loaded: true }),
        callLocal: async () => ({ ok: true, category: 'writing', difficulty: 'easy', latencyMs: 90 }),
      },
    )
    expect(result.source).toBe('local-shadow')
    expect(result.category).toBe('other')
    expect(result.localCategory).toBe('writing')
  })

  it('falls back to rules on timeout or a busy GPU', async () => {
    const timeout = await resolveCategory(
      { text: 'The quarterly report attachments are in the shared drive folder marked Q3 — please reconcile the ledger with finance before the board packet ships next month.', bot: 'orion' },
      live,
      {
        checkAvailable: async () => ({ ok: true, reason: null, loaded: true }),
        callLocal: async () => ({ ok: false, reason: 'timeout', latencyMs: 1500 }),
      },
    )
    expect(timeout.source).toBe('local-timeout')
    expect(timeout.category).toBe('other')

    const busy = await resolveCategory(
      { text: 'The quarterly report attachments are in the shared drive folder marked Q3 — please reconcile the ledger with finance before the board packet ships next month.', bot: 'orion' },
      live,
      { checkAvailable: async () => ({ ok: false, reason: 'gpu_busy', loaded: false }), callLocal: vi.fn() },
    )
    expect(busy.source).toBe('rules')
    expect(busy.skipReason).toBe('gpu_busy')
  })

  it('skips local triage when another model is already loaded', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        models: [
          { id: 'mlx-community--Other-Chat-8B-4bit', loaded: true },
          { id: 'mlx-community--Qwen3.5-9B-4bit', loaded: false },
        ],
      }),
    }))
    const available = await checkLocalAvailable(live, fetchImpl)
    expect(available).toEqual({ ok: false, reason: 'gpu_busy', loaded: false })
  })

  it('covers every official category in the parser', () => {
    for (const category of CATEGORIES) {
      expect(parseTriageResponse(JSON.stringify({ category, difficulty: 'medium' })).category).toBe(category)
    }
  })
})
