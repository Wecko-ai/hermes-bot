import { verifyWebhookAuth } from './webhook-auth.mjs'
import { dedupeKey, payloadFromBody, readRawBody } from './payload.mjs'
import { dedupeRecent, rateLimit } from './rate-limit.mjs'
import { fireRoutineWithExtra } from './fire.mjs'

function loopbackOnly(request) {
  const peer = request.socket?.remoteAddress || ''
  return peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1'
}

export function createRoutineEventHandlers({ store, fetchGateway, host, port, enabled }) {
  function hookUrl(hookId) {
    return `http://127.0.0.1:${port}/api/routines/hooks/${hookId}`
  }

  async function listBindings(profile) {
    if (!enabled) return { enabled: false, bindings: {} }
    const bindings = await store.getBindingsForProfile(profile)
    const mapped = {}
    for (const [jobId, row] of Object.entries(bindings)) {
      mapped[jobId] = {
        trigger: row.trigger,
        auth: row.auth,
        preset: row.preset,
        emailQuery: row.emailQuery || '',
        pollMinutes: row.pollMinutes || 5,
        hookId: row.hookId,
        hookUrl: row.trigger === 'webhook' ? hookUrl(row.hookId) : '',
        enabled: row.enabled !== false,
      }
    }
    return { enabled: true, bindings: mapped }
  }

  async function bind(request, body) {
    const profile = String(body.profile || '')
    const jobId = String(body.jobId || '')
    const result = await store.upsertBinding({
      profile,
      jobId,
      trigger: body.trigger || 'schedule',
      auth: body.auth,
      preset: body.preset,
      emailQuery: body.emailQuery,
      pollMinutes: body.pollMinutes,
      hookId: body.hookId,
      secret: body.secret,
    })
    if (!result) return { ok: true, trigger: 'schedule' }
    return {
      ok: true,
      trigger: result.binding.trigger,
      hookId: result.hookId,
      secret: result.secret,
      hookUrl: result.binding.trigger === 'webhook' ? hookUrl(result.hookId) : '',
      auth: result.binding.auth,
      preset: result.binding.preset,
      emailQuery: result.binding.emailQuery,
      pollMinutes: result.binding.pollMinutes,
    }
  }

  async function regenerate(hookId) {
    const secret = await store.regenerateSecret(hookId)
    if (!secret) return { error: 'not_found' }
    return { ok: true, secret }
  }

  async function runs(profile, jobId) {
    return { runs: await store.listRuns(profile, jobId) }
  }

  async function handleWebhook(request, hookId) {
    if (!enabled) return { status: 404, body: { error: 'not_found' } }
    if (!loopbackOnly(request)) return { status: 403, body: { error: 'forbidden' } }
    const hook = await store.getHook(hookId)
    if (!hook || hook.trigger !== 'webhook' || hook.enabled === false) {
      return { status: 404, body: { error: 'not_found' } }
    }
    if (!rateLimit(`hook:${hookId}`)) return { status: 429, body: { error: 'rate_limited' } }
    let raw
    try {
      raw = await readRawBody(request)
    } catch (cause) {
      if (cause?.message === 'payload_too_large') return { status: 413, body: { error: 'payload_too_large' } }
      return { status: 400, body: { error: 'bad_request' } }
    }
    if (!verifyWebhookAuth({ preset: hook.preset, auth: hook.auth, secret: hook.secret, body: raw, request })) {
      return { status: 401, body: { error: 'unauthorized' } }
    }
    const key = dedupeKey(hook.profile, hook.jobId, raw)
    if (!dedupeRecent(key)) return { status: 200, body: { ok: true, deduped: true } }
    const text = payloadFromBody(raw)
    const result = await fireRoutineWithExtra({
      fetchGateway,
      profile: hook.profile,
      jobId: hook.jobId,
      source: hook.preset === 'github' ? 'webhook:github' : 'webhook',
      extraText: text,
      appendRun: store.appendRun.bind(store),
    })
    if (!result.ok) return { status: 502, body: { error: 'trigger_failed' } }
    return { status: 200, body: { ok: true } }
  }

  return { listBindings, bind, regenerate, runs, handleWebhook, removeJob: store.removeJob.bind(store) }
}