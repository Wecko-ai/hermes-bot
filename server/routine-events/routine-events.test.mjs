import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeEmailAdapter } from './email-adapter.mjs'
import { createRoutineEventHandlers } from './handlers.mjs'
import { resetRateLimitState } from './rate-limit.mjs'
import { createRoutineEventStore } from './store.mjs'
import { verifyGithubSignature } from './webhook-auth.mjs'
import { payloadFromBody } from './payload.mjs'
import { startEmailWatcher } from './watcher.mjs'

const dirs = []

function tempStore() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'routine-events-'))
  dirs.push(dir)
  return createRoutineEventStore(dir)
}

afterEach(() => {
  resetRateLimitState()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('routine event store', () => {
  it('binds webhook metadata and regenerates secrets', async () => {
    const store = tempStore()
    const first = await store.upsertBinding({ profile: 'nova', jobId: 'job-1', trigger: 'webhook', auth: 'bearer' })
    expect(first.hookId).toBeTruthy()
    expect(first.secret.length).toBeGreaterThan(15)
    const row = await store.getByJob('nova', 'job-1')
    expect(row.trigger).toBe('webhook')
    const next = await store.regenerateSecret(first.hookId)
    expect(next).not.toBe(first.secret)
  })

  it('clears bindings when switching back to schedule', async () => {
    const store = tempStore()
    await store.upsertBinding({ profile: 'nova', jobId: 'job-2', trigger: 'webhook' })
    await store.upsertBinding({ profile: 'nova', jobId: 'job-2', trigger: 'schedule' })
    expect(await store.getByJob('nova', 'job-2')).toBeNull()
  })
})

describe('webhook auth and payload', () => {
  it('verifies GitHub signatures', () => {
    const body = Buffer.from('{"hello":true}')
    const secret = 's3cret'
    const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
    const request = { headers: { 'x-hub-signature-256': sig } }
    expect(verifyGithubSignature(body, secret, request)).toBe(true)
  })

  it('sanitizes control characters in payloads', () => {
    const clean = payloadFromBody(Buffer.from('hello\u0001world'))
    expect(clean).toBe('hello world')
  })
})

describe('webhook handler', () => {
  it('fires a routine on authenticated POST', async () => {
    const store = tempStore()
    const fetchMock = vi.fn(async (route) => {
      if (route.includes('/trigger')) return { ok: true, status: 200 }
      return { ok: true, status: 200, json: async () => ({ prompt: 'base prompt' }) }
    })
    const handlers = createRoutineEventHandlers({
      store,
      fetchGateway: fetchMock,
      host: '127.0.0.1',
      port: 4331,
      enabled: true,
    })
    const bound = await handlers.bind({}, { profile: 'nova', jobId: 'cron-1', trigger: 'webhook', auth: 'bearer' })
    const body = Buffer.from('{"event":"ping"}')
    const request = {
      socket: { remoteAddress: '127.0.0.1' },
      headers: { authorization: `Bearer ${bound.secret}` },
      async *[Symbol.asyncIterator]() { yield body },
    }
    const result = await handlers.handleWebhook(request, bound.hookId)
    expect(result.status).toBe(200)
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/trigger'))).toBe(true)
  })
})

describe('email watcher', () => {
  it('polls the fake adapter and marks messages seen', async () => {
    const store = tempStore()
    const adapter = createFakeEmailAdapter([{ id: 'm1', from: 'a@example.com', subject: 'Hello', snippet: 'Body' }])
    const bound = await store.upsertBinding({ profile: 'nova', jobId: 'cron-mail', trigger: 'email', emailQuery: 'hello', pollMinutes: 5 })
    const fire = vi.fn(async () => ({ ok: true }))
    const watcher = startEmailWatcher({ store, adapter, fire, fetchGateway: async () => ({}), pollMs: 5_000 })
    await watcher.tick()
    expect(fire).toHaveBeenCalledTimes(1)
    const hook = await store.getHook(bound.hookId)
    expect(hook.seenMessageIds).toContain('m1')
    watcher.stop()
  })
})