import { describe, expect, it } from 'vitest'
import { applyCompaction, compactionFrom, compressionBody, compressionOfConfig, gaugeFrom, planProfile, profilesFrom } from './compaction.mjs'
import { parseSharedSettings, sharedSettingsFrom, sharedSettingsText, withKeptCompaction } from './shared-settings.mjs'

/** A fake Hermes: one config per profile, written the way the gateway's deep merge does. */
function fakeHermes(configs, { failOn = [] } = {}) {
  const writes = []
  return {
    writes,
    read: async (slug) => {
      if (failOn.includes(slug)) throw new Error('down')
      return structuredClone(configs[slug] ?? {})
    },
    write: async (slug, body) => {
      if (failOn.includes(slug)) throw new Error('down')
      writes.push({ slug, body })
      configs[slug] = { ...configs[slug], compression: { ...configs[slug]?.compression, ...body.config.compression } }
    },
  }
}

describe('compaction du contexte : validation', () => {
  it('keeps the gauge between 10 % and 100 %, to two decimals', () => {
    expect(gaugeFrom(0.5)).toBe(0.5)
    expect(gaugeFrom(0.456)).toBe(0.46)
    expect(gaugeFrom(0.05)).toBeNull()
    expect(gaugeFrom(1.2)).toBeNull()
    expect(gaugeFrom('0.5')).toBeNull()
    expect(gaugeFrom(Number.NaN)).toBeNull()
  })
  it('keeps valid profile names only', () => {
    expect(profilesFrom(['nova', 'nova', '../etc', 'a b', 3, 'default', 'X'])).toEqual(['nova', 'default'])
    expect(profilesFrom('nova')).toEqual([])
  })
  it('reads the two keys of a config, null when absent or invalid', () => {
    expect(compressionOfConfig({ compression: { threshold: 0.6, threshold_tokens: 200000, other: 1 } })).toEqual({ threshold: 0.6, threshold_tokens: 200000 })
    expect(compressionOfConfig({})).toEqual({ threshold: null, threshold_tokens: null })
    expect(compressionOfConfig({ compression: { threshold: 3, threshold_tokens: -1 } })).toEqual({ threshold: null, threshold_tokens: null })
  })
  it('sends the two compression keys and nothing else', () => {
    expect(compressionBody({ threshold: 0.98, threshold_tokens: null })).toEqual({ config: { compression: { threshold: 0.98, threshold_tokens: null } } })
  })
  it('cleans a setting read from the shared file', () => {
    expect(compactionFrom({ mode: 'manual', gauge: 0.4, snapshot: { nova: { threshold: 0.5, threshold_tokens: 60000, extra: 1 }, '../x': {} } }))
      .toEqual({ mode: 'manual', gauge: 0.4, snapshot: { nova: { threshold: 0.5, threshold_tokens: 60000 } } })
    expect(compactionFrom({ mode: 'weird' })?.mode).toBe('auto')
    expect(compactionFrom(null)).toBeNull()
  })
})

describe('compaction du contexte : plan par profil', () => {
  const current = { threshold: 0.5, threshold_tokens: 200000 }
  it('manual: safety net, snapshot of the previous values, never overwritten by a second save', () => {
    const first = planProfile({ mode: 'manual', previous: null, slug: 'nova', current })
    expect(first).toEqual({ write: { threshold: 0.98, threshold_tokens: null }, snapshot: current })
    const again = planProfile({ mode: 'manual', previous: { mode: 'manual', snapshot: { nova: current } }, slug: 'nova', current: { threshold: 0.98, threshold_tokens: null } })
    expect(again.snapshot).toEqual(current)
  })
  it('manual: a profile already on the net with no entry gets no snapshot', () => {
    expect(planProfile({ mode: 'manual', previous: null, slug: 'nova', current: { threshold: 0.98, threshold_tokens: null } }).snapshot).toBeNull()
  })
  it('auto: restores the snapshot, Hermes default for an unset ratio', () => {
    expect(planProfile({ mode: 'auto', previous: { mode: 'manual', snapshot: { nova: current } }, slug: 'nova', current }).write).toEqual({ threshold: 0.5, threshold_tokens: 200000 })
    expect(planProfile({ mode: 'auto', previous: { mode: 'manual', snapshot: { nova: { threshold: null, threshold_tokens: null } } }, slug: 'nova', current }).write).toEqual({ threshold: 0.5, threshold_tokens: null })
  })
  it('auto: writes nothing the first time; defaults for a profile missing from a manual snapshot', () => {
    expect(planProfile({ mode: 'auto', previous: null, slug: 'nova', current }).write).toBeNull()
    expect(planProfile({ mode: 'auto', previous: { mode: 'auto', snapshot: {} }, slug: 'nova', current }).write).toBeNull()
    expect(planProfile({ mode: 'auto', previous: { mode: 'manual', snapshot: {} }, slug: 'nova', current }).write).toEqual({ threshold: 0.5, threshold_tokens: null })
  })
})

describe('compaction du contexte : écriture dans les profils', () => {
  const configs = () => ({
    nova: { model: 'x', compression: { threshold: 0.5, threshold_tokens: 200000 } },
    orion: { model: 'y', compression: { threshold: 0.6, threshold_tokens: 60000 } },
    atlas: { model: 'z' },
  })
  it('manual then auto: every profile gets only compression keys, then gets its old values back', async () => {
    const store = configs()
    const hermes = fakeHermes(store)
    const manual = await applyCompaction({ mode: 'manual', gauge: 0.5, profiles: ['nova', 'orion', 'atlas'], previous: null, hermes })
    expect(manual.failed).toEqual([])
    expect(hermes.writes.every((entry) => Object.keys(entry.body).join() === 'config' && Object.keys(entry.body.config).join() === 'compression')).toBe(true)
    expect(store.nova.compression).toEqual({ threshold: 0.98, threshold_tokens: null })
    expect(manual.settings.snapshot.orion).toEqual({ threshold: 0.6, threshold_tokens: 60000 })
    expect(manual.settings.snapshot.atlas).toEqual({ threshold: null, threshold_tokens: null })
    const auto = await applyCompaction({ mode: 'auto', gauge: 0.5, profiles: ['nova', 'orion', 'atlas'], previous: manual.settings, hermes })
    expect(store.nova.compression).toEqual({ threshold: 0.5, threshold_tokens: 200000 })
    expect(store.orion.compression).toEqual({ threshold: 0.6, threshold_tokens: 60000 })
    expect(store.atlas.compression).toEqual({ threshold: 0.5, threshold_tokens: null })
    expect(auto.settings.snapshot).toEqual({})
    expect(store.nova.model).toBe('x')
  })
  it('a failing profile is listed, the others go on, and its snapshot entry is kept', async () => {
    const store = configs()
    const hermes = fakeHermes(store, { failOn: ['orion'] })
    const manual = await applyCompaction({ mode: 'manual', gauge: 0.4, profiles: ['nova', 'orion'], previous: null, hermes })
    expect(manual.applied).toEqual(['nova'])
    expect(manual.failed).toEqual(['orion'])
    expect(manual.settings.snapshot.orion).toBeUndefined()
    expect(store.orion.compression.threshold).toBe(0.6)
  })
  it('auto on a first use writes nothing at all', async () => {
    const store = configs()
    const hermes = fakeHermes(store)
    const result = await applyCompaction({ mode: 'auto', gauge: 1, profiles: ['nova'], previous: null, hermes })
    expect(hermes.writes).toEqual([])
    expect(result.applied).toEqual(['nova'])
  })
})

describe('compaction du contexte : fichier partagé', () => {
  it('is kept by the shared file and cannot be set through the hidden models route', () => {
    const file = sharedSettingsText({ hiddenModels: ['a:b'], compaction: { mode: 'manual', gauge: 0.5, snapshot: { nova: { threshold: 0.5, threshold_tokens: null } } } })
    const existing = parseSharedSettings(file)
    expect(existing.compaction.mode).toBe('manual')
    const forged = sharedSettingsFrom({ hiddenModels: [], compaction: { mode: 'auto', gauge: 1, snapshot: {} } })
    expect(withKeptCompaction(existing, forged).compaction).toEqual(existing.compaction)
    expect(withKeptCompaction({}, forged).compaction).toBeUndefined()
  })
})
