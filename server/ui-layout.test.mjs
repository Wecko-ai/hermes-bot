import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadUiLayout, normalizeUiLayout, saveUiLayout } from './ui-layout.mjs'

describe('ui-layout.mjs', () => {
  it('normalizes section and roster order', () => {
    expect(normalizeUiLayout({ sectionOrder: ['A', 1, ''], rosterOrder: { A: ['a', '../x'] } })).toEqual({
      sectionOrder: ['A'],
      rosterOrder: { A: ['a'] },
    })
  })

  it('persists layout in config.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-ui-'))
    const layout = saveUiLayout(dir, { sectionOrder: ['Team'], rosterOrder: { Team: ['orion', 'nova'] } })
    expect(layout.sectionOrder).toEqual(['Team'])
    expect(loadUiLayout(dir)).toEqual(layout)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})