import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ensureStore, formatEntry, memoryDir, parseMemoryFile, removeEntry, searchEntries, summarizeForTurn, upsertEntry,
} from './shared-memory.mjs'

describe('shared memory', () => {
  it('résout le dossier par défaut sous le data dir', () => {
    expect(memoryDir('', '/data')).toBe(path.join('/data', 'shared-memory'))
    expect(memoryDir('/custom', '/data')).toBe('/custom')
    expect(memoryDir('relative', '/data')).toBe(path.join('/data', 'shared-memory'))
  })

  it('parse les entrées avec date et source', () => {
    const text = `# Rules\n\n## No secrets in chat\n<!-- memory: 2026-11-22T10:00:00Z | source: user -->\nNever paste tokens.\n`
    const parsed = parseMemoryFile(text, 'rules')
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.entries[0]).toMatchObject({ title: 'No secrets in chat', date: '2026-11-22T10:00:00Z', source: 'user', body: 'Never paste tokens.' })
  })

  it('ajoute, met à jour et retire une entrée', () => {
    const base = '# People\n\n'
    const first = upsertEntry(base, { id: 'alex', type: 'people', title: 'Alex', date: '2026-11-22', source: 'user', body: 'Owner.' })
    const second = upsertEntry(first, { id: 'alex', type: 'people', title: 'Alex', date: '2026-11-23', source: 'user', body: 'Owner and engineer.' })
    expect(parseMemoryFile(second, 'people').entries[0].body).toBe('Owner and engineer.')
    const cleared = removeEntry(second, 'alex')
    expect(parseMemoryFile(cleared, 'people').entries).toHaveLength(0)
  })

  it('recherche dans tous les types', () => {
    const files = {
      profile: formatEntry({ title: 'Language', date: '', source: 'user', body: 'French UI' }),
      rules: formatEntry({ title: 'Tokens', date: '', source: 'user', body: 'No API keys in chat' }),
      people: '# People\n\n',
      workstreams: '# Workstreams\n\n',
    }
    const hits = searchEntries(files, 'api keys')
    expect(hits).toHaveLength(1)
    expect(hits[0].title).toBe('Tokens')
  })

  it('résume pour une injection courte', () => {
    const files = { profile: '# Profile\n\n', rules: '# Rules\n\n', people: '# People\n\n', workstreams: '# Workstreams\n\n' }
    files.profile += formatEntry({ title: 'Timezone', date: '', source: 'user', body: 'UTC+9' })
    const summary = summarizeForTurn(files, 500)
    expect(summary).toContain('shared memory')
    expect(summary).toContain('Timezone')
  })

  it('initialise le magasin sur disque', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hb-memory-'))
    await ensureStore(dir)
    const parsed = parseMemoryFile(await import('node:fs/promises').then((m) => m.readFile(path.join(dir, 'profile.md'), 'utf8')), 'profile')
    expect(parsed.text.startsWith('# Profile')).toBe(true)
  })
})