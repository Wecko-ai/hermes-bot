import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConnectorsCatalog } from './connectors-catalog.mjs'

const dirs = []

afterEach(() => {
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})

function fixture(content) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'connectors-catalog-'))
  const dir = path.join(root, 'sample')
  mkdirSync(dir)
  writeFileSync(path.join(dir, 'manifest.yaml'), content)
  dirs.push(root)
  return root
}

describe('loadConnectorsCatalog', () => {
  it('reads approved MCP manifests without secret values', async () => {
    const dir = fixture(`name: sample\nauth:\n  type: oauth\ndescription: 'Sample connector'\n`)
    const list = await loadConnectorsCatalog(dir)
    expect(list).toEqual([{ name: 'sample', description: 'Sample connector', auth: 'oauth', requires: [] }])
  })

  it('lists required env key names only', async () => {
    const dir = fixture(`name: keyed\nauth:\n  type: oauth\n  env:\n    - name: SAMPLE_API_KEY\n      secret: true\ndescription: Keyed\n`)
    const list = await loadConnectorsCatalog(dir)
    expect(list[0].requires).toEqual(['SAMPLE_API_KEY'])
  })
})