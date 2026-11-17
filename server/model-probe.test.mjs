import { describe, expect, it } from 'vitest'
import { createModelProbe, probeVerdict } from './model-probe.mjs'

const reply = (status, body) => async () => ({ status, json: async () => body })

describe('probeVerdict', () => {
  it('accepts a completed answer', () => {
    expect(probeVerdict(200, { status: 'completed', output: [] })).toEqual({ checked: true, ok: true })
  })

  it('reads a quota refusal sent as a failed response', () => {
    const verdict = probeVerdict(200, { status: 'failed', error: { code: 'rate_limit_exceeded', type: 'rate_limit_error', message: 'Cursor rate limit exceeded' } })
    expect(verdict).toMatchObject({ checked: true, ok: false, reason: 'quota', message: 'Cursor rate limit exceeded' })
  })

  it('reads an HTTP 429 as quota and another failure as an error', () => {
    expect(probeVerdict(429, null)).toMatchObject({ ok: false, reason: 'quota', message: 'HTTP 429' })
    expect(probeVerdict(404, { error: { message: 'model not found\n' } })).toMatchObject({ ok: false, reason: 'error', message: 'model not found' })
  })
})

describe('createModelProbe', () => {
  const probes = [{ prefix: 'cursor/', base: 'http://127.0.0.1:10100/v1' }]

  it('does not ask for a model no probe covers', async () => {
    let calls = 0
    const probe = createModelProbe({ probes, fetchImpl: async () => { calls += 1; return reply(200, {})() } })
    expect(await probe.check('claude-sonnet-5-5')).toEqual({ checked: false })
    expect(calls).toBe(0)
  })

  it('posts a tiny Responses request to the configured base, with no credential', async () => {
    const seen = []
    const probe = createModelProbe({ probes, fetchImpl: async (url, init) => { seen.push({ url, init }); return reply(200, { status: 'completed' })() } })
    expect(await probe.check('cursor/composer-2.5')).toEqual({ checked: true, ok: true })
    expect(seen[0].url).toBe('http://127.0.0.1:10100/v1/responses')
    expect(JSON.parse(seen[0].init.body)).toMatchObject({ model: 'cursor/composer-2.5', max_output_tokens: 16, stream: false })
    expect(Object.keys(seen[0].init.headers)).toEqual(['Content-Type'])
  })

  it('caches answers, a refusal for a shorter time', async () => {
    let clock = 0
    let calls = 0
    const probe = createModelProbe({ probes, now: () => clock, fetchImpl: async () => { calls += 1; return reply(200, { status: 'failed', error: { code: 'rate_limit_exceeded' } })() } })
    await probe.check('cursor/claude-sonnet-5-5')
    clock = 60_000
    await probe.check('cursor/claude-sonnet-5-5')
    expect(calls).toBe(1)
    clock = 3 * 60_000
    await probe.check('cursor/claude-sonnet-5-5')
    expect(calls).toBe(2)
  })

  it('stays silent when the endpoint is down, and refuses a malformed id', async () => {
    const probe = createModelProbe({ probes, fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
    expect(await probe.check('cursor/grok-4.7')).toEqual({ checked: false })
    expect(await probe.check('cursor/../x y')).toMatchObject({ invalid: true })
  })
})
