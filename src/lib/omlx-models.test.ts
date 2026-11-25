import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SPLASH_MODELS, loadModelOptions, type HermesClient } from './hermes'

describe('loadModelOptions local oMLX merge', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    if (typeof localStorage !== 'undefined') localStorage.clear()
  })

  it('merges live /api/omlx/models into the omlx provider without duplicates', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.endsWith('/api/omlx/models')) {
        return {
          ok: true,
          json: async () => ({
            available: true,
            models: [
              'Jundot--Qwen3.8-27B-oQ4e-mtp',
              'mlx-community--Local-Sample-4bit',
              'mlx-community--Qwen3.5-9B-4bit',
            ],
          }),
        }
      }
      return { ok: true, json: async () => ({ available: false, models: [] }) }
    }))

    const client = {
      request: vi.fn(async () => ({
        model: 'Jundot--Qwen3.8-27B-oQ4e-mtp',
        providers: [
          {
            slug: 'omlx',
            name: 'Qwen local (oMLX)',
            authenticated: true,
            models: ['Jundot--Qwen3.8-27B-oQ4e-mtp'],
          },
        ],
      })),
    } as unknown as HermesClient

    const result = await loadModelOptions(client, 'demo-bot')
    expect(result.options.filter((item) => item.provider === 'omlx').map((item) => item.model)).toEqual([
      'Jundot--Qwen3.8-27B-oQ4e-mtp',
      'mlx-community--Local-Sample-4bit',
      'mlx-community--Qwen3.5-9B-4bit',
    ])
    expect(result.options.filter((item) => item.provider === 'splash').map((item) => item.model)).toEqual(DEFAULT_SPLASH_MODELS)
  })

  it('merges live /api/splash/models into the custom:splash provider without duplicates', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.endsWith('/api/splash/models')) {
        return {
          ok: true,
          json: async () => ({
            available: true,
            models: ['Local-Model-128K', 'Local-Model-256K'],
          }),
        }
      }
      return { ok: true, json: async () => ({ available: false, models: [] }) }
    }))

    const client = {
      request: vi.fn(async () => ({
        model: 'Local-Model-128K',
        providers: [
          {
            slug: 'custom:splash',
            name: 'Local Splash Server',
            authenticated: true,
            models: ['Local-Model-128K'],
          },
        ],
      })),
    } as unknown as HermesClient

    const result = await loadModelOptions(client, 'demo-bot')
    expect(result.options.map((item) => item.model)).toEqual([
      'Local-Model-128K',
      'Local-Model-256K',
    ])
    expect(result.options.every((item) => item.provider === 'custom:splash')).toBe(true)
  })
  it('keeps an unauthenticated Splash provider and still merges live models', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.endsWith('/api/splash/models')) {
        return { ok: true, json: async () => ({ available: true, models: ['Inkling-2-Mini-128K', 'Inkling-2-Mini-256K'] }) }
      }
      return { ok: true, json: async () => ({ available: false, models: [] }) }
    }))
    const client = {
      request: vi.fn(async () => ({
        model: 'kimi-for-coding',
        providers: [
          { slug: 'kimi-coding', name: 'Kimi / Moonshot', authenticated: true, models: ['kimi-for-coding'] },
          { slug: 'splash', name: 'Inkling 2 Mini (Splash)', authenticated: false, models: ['Inkling-2-Mini-128K'] },
        ],
      })),
    } as unknown as HermesClient
    const result = await loadModelOptions(client, 'demo-bot')
    const splash = result.options.filter((item) => item.provider === 'splash')
    expect(splash.map((item) => item.model)).toEqual(['Inkling-2-Mini-128K', 'Inkling-2-Mini-256K'])
  })

  it('offers Inkling fallback when the gateway omits Splash and the live endpoint is empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ available: false, models: [] }) })))
    const client = {
      request: vi.fn(async () => ({
        model: 'kimi-for-coding',
        providers: [
          { slug: 'kimi-coding', name: 'Kimi / Moonshot', authenticated: true, models: ['kimi-for-coding'] },
        ],
      })),
    } as unknown as HermesClient
    const result = await loadModelOptions(client, 'demo-bot')
    const splash = result.options.filter((item) => item.provider === 'splash')
    expect(splash.map((item) => item.model)).toEqual(['Inkling-2-Mini-128K', 'Inkling-2-Mini-256K'])
    expect(splash.every((item) => item.providerName === 'Inkling 2 Mini (Splash)')).toBe(true)
  })

  it('does not remember a Cursor model under the Kimi provider', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ available: false, models: [] }) })))
    const store: Record<string, string> = {
      'hermesbot-model-memory': JSON.stringify({
        'kimi-coding': [['cursor/grok-4.7', Date.now()], ['kimi-for-coding', Date.now()]],
      }),
    }
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value },
      removeItem: (key: string) => { delete store[key] },
      clear: () => { for (const key of Object.keys(store)) delete store[key] },
    })
    const client = {
      request: vi.fn(async () => ({
        model: 'kimi-for-coding',
        providers: [
          { slug: 'kimi-coding', name: 'Kimi / Moonshot', authenticated: true, models: ['kimi-for-coding'] },
        ],
      })),
    } as unknown as HermesClient
    const result = await loadModelOptions(client, 'demo-bot')
    const kimi = result.options.filter((item) => item.provider === 'kimi-coding')
    expect(kimi.map((item) => item.model)).not.toContain('cursor/grok-4.7')
    expect(kimi.map((item) => item.model)).toContain('kimi-for-coding')
  })
})
