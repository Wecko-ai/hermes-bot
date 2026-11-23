import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBotFromTemplate, validateBotTemplate } from './bot-import'

describe('bot import', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('validates a template through the local server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, soul: 'Hello', configBody: { config: { toolsets: { enabled: ['web'] } } } }),
    })))
    const file = new File([JSON.stringify({ version: 1, soul: 'Hello' })], 'bot.json', { type: 'application/json' })
    const result = await validateBotTemplate(file)
    expect(result.soul).toBe('Hello')
  })

  it('creates a profile and writes toolsets', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'profiles.create') return { ok: true }
      if (method === 'profiles.list') return { profiles: [{ name: 'iris', ui_meta: {} }] }
      if (method === 'setup.runtime_check') return { ok: true }
      if (method === 'profiles.configure') return { ok: true }
      return {}
    })
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') return { ok: true, json: async () => ({ ok: true }) }
      return { ok: true, json: async () => ({}) }
    }))
    const result = await createBotFromTemplate(
      { request },
      { title: 'Iris', slug: 'iris', color: '#3B82C4', shape: 'blob' },
      { soul: 'Imported', configBody: { config: { toolsets: { enabled: ['web'] } } }, card: { title: 'Iris' } },
    )
    expect(result.slug).toBe('iris')
    expect(request).toHaveBeenCalledWith('profiles.create', expect.objectContaining({ soul: 'Imported' }))
  })
})