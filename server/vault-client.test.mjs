import { describe, expect, it } from 'vitest'
import { postVaultLogout, reduceVaultPoll, selectVaultToken, vaultRequestHeaders } from './vault-client.mjs'

const TOKEN = 'ab'.repeat(32)
const OTHER = 'cd'.repeat(32)

describe('vault token', () => {
  it('prefers the in-memory token, then the environment, then the file', () => {
    let reads = 0
    const readFile = () => { reads += 1; return OTHER }
    expect(selectVaultToken(TOKEN, OTHER, readFile)).toBe(TOKEN)
    expect(reads).toBe(0)
    expect(selectVaultToken('', OTHER, readFile)).toBe(OTHER)
    expect(reads).toBe(0)
    expect(selectVaultToken('nope', 'nope', readFile)).toBe(OTHER)
    expect(selectVaultToken('', '', () => { throw new Error('missing') })).toBe('')
    expect(selectVaultToken('', '', () => 'short')).toBe('')
  })
})

describe('vault admin headers', () => {
  it('sends the Hermes cookie only on a POST that has one', () => {
    expect(vaultRequestHeaders('GET', TOKEN, 'hermes_session=1')).toEqual({ Authorization: `Bearer ${TOKEN}` })
    expect(vaultRequestHeaders('GET', TOKEN, '')).toEqual({ Authorization: `Bearer ${TOKEN}` })
    expect(vaultRequestHeaders('POST', TOKEN, 'hermes_session=1')).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'X-Hermes-Cookie': 'hermes_session=1',
    })
    expect(vaultRequestHeaders('POST', TOKEN, '')).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    })
  })
})

describe('vault poll', () => {
  const previous = { requests: '[{"id":"card"}]', notices: '[{"id":"note"}]' }

  it('keeps the previous requests and notices when the answer is unusable', () => {
    expect(reduceVaultPoll(previous, 503, { error: 'vault_service_unavailable' })).toEqual(previous)
    expect(reduceVaultPoll(previous, 403, {})).toEqual(previous)
    expect(reduceVaultPoll(previous, 200, null)).toEqual(previous)
    expect(reduceVaultPoll(previous, 200, {})).toEqual(previous)
    expect(reduceVaultPoll(previous, 200, { requests: 'nope', notices: {} })).toEqual(previous)
  })

  it('replaces a snapshot only when that field is an array', () => {
    expect(reduceVaultPoll(previous, 200, { requests: [], notices: [{ id: 'next' }] })).toEqual({
      requests: '[]',
      notices: '[{"id":"next"}]',
    })
    expect(reduceVaultPoll(previous, 200, { requests: [{ id: 'card-2' }] })).toEqual({
      requests: '[{"id":"card-2"}]',
      notices: previous.notices,
    })
  })
})

describe('vault logout', () => {
  it('posts the bearer and ignores a missing route or a down vault', async () => {
    const calls = []
    await postVaultLogout('http://127.0.0.1:4331', TOKEN, async (url, init) => {
      calls.push({ url, init })
      return { status: 404, body: { cancel: async () => {} } }
    })
    expect(calls).toEqual([{
      url: 'http://127.0.0.1:4331/admin/v1/logout',
      init: {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        signal: expect.any(AbortSignal),
      },
    }])
    expect(calls[0].init.headers['X-Hermes-Cookie']).toBeUndefined()
    await expect(postVaultLogout('http://127.0.0.1:4331', TOKEN, async () => { throw new Error('down') })).resolves.toBeUndefined()
    await postVaultLogout('http://127.0.0.1:4331', 'short', async () => { throw new Error('should not be called') })
  })
})
