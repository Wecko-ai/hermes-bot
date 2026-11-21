import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeHiddenModels, saveHiddenModels, saveZeroSpend, syncSharedSettings } from './shared-settings'
import { getSettings, updateSettings } from './settings'
import { DEFAULT_APP_CONFIG, parseAppConfig, setAppConfig } from './app-config'

describe('modèles masqués partagés', () => {
  it('n’envoie que les changements de cette fenêtre, sur la copie la plus récente', () => {
    // This window started from [a, b]; meanwhile the other Mac showed b and hid c.
    const remote = ['a', 'c']
    // Here: a shown, d hidden. b was not touched here, so it stays shown.
    expect(mergeHiddenModels(remote, ['a', 'b'], ['b', 'd'])).toEqual(['c', 'd'])
  })

  it('ne remasque pas un modèle réaffiché ailleurs quand on touche à un autre', () => {
    // The old bug: a window with an old list hid Sonnet again when any other model was changed.
    const remote = ['anthropic:claude-opus-4-8']
    const staleBaseline = ['anthropic:claude-opus-4-8', 'anthropic:claude-sonnet-5-5']
    const draft = [...staleBaseline, 'kimi-coding:kimi-k3']
    expect(mergeHiddenModels(remote, staleBaseline, draft)).toEqual(['anthropic:claude-opus-4-8', 'kimi-coding:kimi-k3'])
  })

  it('n’ajoute pas deux fois la même clé', () => {
    expect(mergeHiddenModels(['x'], [], ['x', 'y', 'y'])).toEqual(['x', 'y'])
  })
})

describe('enregistrement des modèles masqués', () => {
  const calls: Array<{ method: string; body?: unknown }> = []
  let remote: { exists: boolean; settings: { hiddenModels: string[]; zeroSpend?: boolean; compaction?: unknown } } = { exists: true, settings: { hiddenModels: [] } }
  let putOk = true

  beforeEach(() => {
    calls.length = 0
    putOk = true
    setAppConfig(DEFAULT_APP_CONFIG)
    updateSettings({ hiddenModels: [], freeMode: false })
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const method = init?.method || 'GET'
      calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (method === 'PUT') return { ok: putOk, json: async () => ({ ok: putOk }) }
      return { ok: true, json: async () => remote }
    }))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('lit la copie de la gateway avant d’écrire, et garde le résultat dans la fenêtre', async () => {
    remote = { exists: true, settings: { hiddenModels: ['p:other'], zeroSpend: true } }
    const result = await saveHiddenModels([], ['p:mine'])
    expect(result).toEqual({ ok: true, hiddenModels: ['p:other', 'p:mine'] })
    expect(calls.map((call) => call.method)).toEqual(['GET', 'PUT'])
    expect(calls[1].body).toEqual({ hiddenModels: ['p:other', 'p:mine'], zeroSpend: true })
    expect(getSettings().hiddenModels).toEqual(['p:other', 'p:mine'])
  })

  it('garde le brouillon si la gateway refuse : rien n’est changé dans la fenêtre', async () => {
    updateSettings({ hiddenModels: ['p:saved'] })
    putOk = false
    const result = await saveHiddenModels(['p:saved'], [])
    expect(result.ok).toBe(false)
    expect(getSettings().hiddenModels).toEqual(['p:saved'])
  })

  it('n’écrit rien quand on change un autre réglage', async () => {
    remote = { exists: true, settings: { hiddenModels: ['p:a'] } }
    await syncSharedSettings()
    calls.length = 0
    updateSettings({ theme: 'dark' })
    updateSettings({ hiddenModels: ['p:a', 'p:b'] })
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(calls).toEqual([])
  })

  it('suit la compaction du contexte enregistrée sur la gateway, sans rien écrire', async () => {
    updateSettings({ compactionMode: 'auto', compactionGauge: 1 })
    remote = { exists: true, settings: { hiddenModels: [], compaction: { mode: 'manual', gauge: 0.4 } } } as typeof remote
    await syncSharedSettings()
    expect(getSettings()).toMatchObject({ compactionMode: 'manual', compactionGauge: 0.4 })
    expect(calls.map((call) => call.method)).toEqual(['GET'])
  })

  it('suit le réglage zéro frais partagé, sans écraser les modèles masqués', async () => {
    remote = { exists: true, settings: { hiddenModels: ['p:a'], zeroSpend: true } }
    expect(await saveZeroSpend(false)).toBe(true)
    expect(calls.map((call) => call.method)).toEqual(['GET', 'PUT'])
    expect(calls[1].body).toEqual({ hiddenModels: ['p:a'], zeroSpend: false })
    expect(getSettings().freeMode).toBe(false)
  })

  it('en cas d’échec, conserve le réglage zéro frais précédent', async () => {
    updateSettings({ freeMode: true })
    remote = { exists: true, settings: { hiddenModels: ['p:a'], zeroSpend: true } }
    putOk = false
    expect(await saveZeroSpend(false)).toBe(false)
    expect(getSettings().freeMode).toBe(true)
  })

  it('utilise le défaut de l’installation quand le fichier partagé n’a pas encore de booléen', async () => {
    setAppConfig(parseAppConfig({ ui: { zeroSpendDefault: true } }))
    remote = { exists: true, settings: { hiddenModels: [] } }
    await syncSharedSettings()
    expect(getSettings().freeMode).toBe(true)
    expect(calls.map((call) => call.method)).toEqual(['GET'])
  })

  it('conserve l’ancien mode gratuit local comme repli tant que le partagé est absent', async () => {
    updateSettings({ freeMode: true })
    remote = { exists: true, settings: { hiddenModels: [] } }
    await syncSharedSettings()
    expect(getSettings().freeMode).toBe(true)
    expect(calls.map((call) => call.method)).toEqual(['GET'])
  })

  it('en démo, zéro frais reste local et ne fait aucune requête', async () => {
    expect(await saveZeroSpend(true, { local: true })).toBe(true)
    expect(getSettings().freeMode).toBe(true)
    expect(calls).toEqual([])
  })

  it('en démo, enregistre dans la fenêtre seulement', async () => {
    const result = await saveHiddenModels([], ['p:demo'], { local: true })
    expect(result.ok).toBe(true)
    expect(calls).toEqual([])
    expect(getSettings().hiddenModels).toEqual(['p:demo'])
  })
})
