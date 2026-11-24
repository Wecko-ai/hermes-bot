import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadModelOptions, type HermesClient } from './hermes'

describe('loadModelOptions local oMLX merge', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    if (typeof localStorage !== 'undefined') localStorage.clear()
  })

  it('merges live /api/omlx/models into the omlx provider without duplicates', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        available: true,
        models: [
          'Jundot--Qwen3.8-27B-oQ4e-mtp',
          'mlx-community--Local-Sample-4bit',
          'mlx-community--Qwen3.5-9B-4bit',
        ],
      }),
    })))

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
    expect(result.options.map((item) => item.model)).toEqual([
      'Jundot--Qwen3.8-27B-oQ4e-mtp',
      'mlx-community--Local-Sample-4bit',
      'mlx-community--Qwen3.5-9B-4bit',
    ])
    expect(result.options.every((item) => item.provider === 'omlx')).toBe(true)
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
})
