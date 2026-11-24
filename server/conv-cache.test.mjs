import { mkdtemp, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createConvCache } from './conv-cache.mjs'

const message = (id) => ({ id: String(id), role: 'assistant', content: 'x'.repeat(80), createdAt: '2026-11-23T00:00:00.000Z' })

describe('conversation replica store', () => {
  it('keeps the last 200 messages and boots the last selection', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'conv-cache-'))
    const cache = createConvCache(dir)
    const messages = Array.from({ length: 250 }, (_, index) => message(index + 1))
    expect(await cache.saveReplica({ profile: 'alpha', sessionId: 'sess', revision: 'v1|sess|250|250|0', lastId: 250, messages, model: 'k3' })).toBe(true)
    await cache.saveSelection('alpha')
    await cache.saveRoster([{ slug: 'alpha', name: 'Alpha' }])
    const boot = await cache.boot()
    expect(boot.selection).toBe('alpha')
    expect(boot.roster).toEqual([{ slug: 'alpha', name: 'Alpha' }])
    expect(boot.replica.messages).toHaveLength(200)
    expect(boot.replica.messages[0].id).toBe('51')
    expect(boot.replica.messages.at(-1).id).toBe('250')
    expect(boot.replica.hasOlder).toBe(true)
    expect(boot.replica.sessionId).toBe('sess')
  })

  it('rejects a profile that could leave the cache directory', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'conv-cache-'))
    const cache = createConvCache(dir)
    expect(await cache.saveReplica({ profile: '../etc', messages: [message(1)] })).toBe(false)
    expect(await cache.replica('../etc')).toBe(null)
  })

  it('evicts the oldest replica once the cap is passed and keeps the newest', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'conv-cache-'))
    let clock = 1_000
    const cache = createConvCache(dir, { maxBytes: 1500, now: () => clock })
    await cache.saveReplica({ profile: 'old', messages: [message(1), { ...message(2), content: 'y'.repeat(800) }] })
    clock += 10
    await cache.saveReplica({ profile: 'new', messages: [message(3), { ...message(4), content: 'z'.repeat(800) }] })
    expect(await cache.replica('old')).toBe(null)
    expect((await cache.replica('new')).profile).toBe('new')
    const left = await stat(path.join(dir, 'replicas', 'new.json'))
    expect(left.isFile()).toBe(true)
  })
})
