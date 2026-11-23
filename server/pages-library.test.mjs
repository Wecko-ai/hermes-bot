import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PagesLibrary } from './pages-library.mjs'

describe('pages-library', () => {
  it('enregistre, renomme et archive une page', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'hb-pages-'))
    const library = new PagesLibrary(root)
    const id = await library.touch({ profile: 'orion', filePath: '/tmp/report.pdf', name: 'report.pdf', title: 'Report' })
    expect((await library.list('orion')).some((item) => item.id === id)).toBe(true)
    await library.rename('orion', id, 'Annual report')
    expect((await library.list('orion')).find((item) => item.id === id)?.title).toBe('Annual report')
    await library.archive('orion', id)
    expect(await library.list('orion')).toHaveLength(0)
    expect((await library.list('orion', { archived: true })).find((item) => item.id === id)?.archived).toBe(true)
  })
})