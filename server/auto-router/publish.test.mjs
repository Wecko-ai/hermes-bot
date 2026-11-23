import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { publishAutoRouterFiles, publicAutoRouter, PUBLISHED_TABLE_PATH } from './publish.mjs'

describe('auto router capability published for the phone', () => {
  it('describes Auto without a table path until the copy exists', () => {
    expect(publicAutoRouter({ enabled: false })).toEqual({ enabled: false })
    expect(publicAutoRouter({ enabled: true })).toEqual({ enabled: true })
    expect(publicAutoRouter({ enabled: true }, { tablePublished: true })).toEqual({
      enabled: true,
      tablePath: PUBLISHED_TABLE_PATH,
    })
  })

  it('merges the capability into the shared file and copies the scoring table', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'hb-auto-pub-'))
    try {
      const source = path.join(home, 'source-table.json')
      await writeFile(source, '{"models":{"nvidia/llama":{"label":"Llama"}}}\n')
      await writeFile(path.join(home, 'hermesbot-settings.json'), `${JSON.stringify({
        version: 1,
        hiddenModels: ['keep:me'],
        zeroSpend: true,
        compaction: { mode: 'manual', gauge: 0.4, snapshot: { orion: { threshold: 0.5, threshold_tokens: null } } },
      }, null, 2)}\n`)
      const first = await publishAutoRouterFiles({
        hermesHome: home,
        autoRouter: { enabled: true, logDir: '/secret/log' },
        sourceTablePath: source,
      })
      expect(first).toMatchObject({ ok: true, changed: true, tablePublished: true })
      const saved = JSON.parse(await readFile(path.join(home, 'hermesbot-settings.json'), 'utf8'))
      expect(saved.hiddenModels).toEqual(['keep:me'])
      expect(saved.zeroSpend).toBe(true)
      expect(saved.compaction.snapshot.orion.threshold).toBe(0.5)
      expect(saved.autoRouter).toEqual({ enabled: true, tablePath: PUBLISHED_TABLE_PATH })
      expect(saved.autoRouter.logDir).toBeUndefined()
      expect(JSON.parse(await readFile(path.join(home, 'hermesbot-auto-router.table.json'), 'utf8')).models['nvidia/llama'].label).toBe('Llama')
      const again = await publishAutoRouterFiles({
        hermesHome: home,
        autoRouter: { enabled: true },
        sourceTablePath: source,
      })
      expect(again.changed).toBe(false)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('turns Auto off without rewriting a file that is not JSON', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'hb-auto-pub-'))
    try {
      const settings = path.join(home, 'hermesbot-settings.json')
      await writeFile(settings, '{oops')
      const broken = await publishAutoRouterFiles({ hermesHome: home, autoRouter: { enabled: true } })
      expect(broken).toMatchObject({ ok: false, reason: 'unreadable' })
      expect(await readFile(settings, 'utf8')).toBe('{oops')
      await writeFile(settings, '{"version":1,"autoRouter":{"enabled":true,"tablePath":"~/.hermes/hermesbot-auto-router.table.json"}}\n')
      const off = await publishAutoRouterFiles({ hermesHome: home, autoRouter: { enabled: false } })
      expect(off.changed).toBe(true)
      expect(JSON.parse(await readFile(settings, 'utf8')).autoRouter).toEqual({ enabled: false })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
