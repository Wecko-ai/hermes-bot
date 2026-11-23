// Live check of a model before a chat switches to it.
//
// A provider that refuses a model for quota still lists it in `model.options`, and the gateway's
// `setup.runtime_check` only looks at the provider's key. Hermes then finds out on the next turn and
// silently moves the conversation to the profile's fallback. For the model-id prefixes configured in
// `modelProbes` (server/config.cjs), the server asks that endpoint for a tiny reply first.
// The endpoint is a keyless local proxy: no credential is read, stored or sent.

import { isSafeModelId } from './model-id.mjs'
const PROBE_TIMEOUT_MS = 45_000
/** A model that answered stays trusted this long; a refusal is asked again sooner, quotas reset. */
const OK_TTL_MS = 10 * 60_000
const REFUSED_TTL_MS = 2 * 60_000
const MAX_MESSAGE = 300

const cleanMessage = (value) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_MESSAGE)
  : ''

/** Reads one Responses answer: completed, refused for quota or rate, or another failure. */
export function probeVerdict(status, body) {
  const error = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : null
  if (status >= 200 && status < 300 && body?.status === 'completed' && !error) return { checked: true, ok: true }
  const code = typeof error?.code === 'string' ? error.code : ''
  const type = typeof error?.type === 'string' ? error.type : ''
  const quota = status === 429 || /rate_limit|quota|insufficient/i.test(code) || /rate_limit|quota/i.test(type)
  return { checked: true, ok: false, reason: quota ? 'quota' : 'error', message: cleanMessage(error?.message) || `HTTP ${status}` }
}

export function createModelProbe({ probes = [], fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map()
  const pending = new Map()

  async function ask(model, probe) {
    try {
      const response = await fetchImpl(`${probe.base}/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: 'Reply with exactly: OK', max_output_tokens: 16, stream: false }),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      let body = null
      try { body = await response.json() } catch { body = null }
      return probeVerdict(response.status, body)
    } catch {
      // The endpoint is down or slow: say nothing rather than block a switch on a guess.
      return { checked: false }
    }
  }

  /** `{checked: false}` when no probe covers this model or the endpoint did not answer. */
  async function check(model) {
    if (!isSafeModelId(model)) return { checked: false, invalid: true }
    const probe = probes.find((item) => model.startsWith(item.prefix))
    if (!probe) return { checked: false }
    const cached = cache.get(model)
    if (cached && cached.until > now()) return cached.result
    const running = pending.get(model)
    if (running) return running
    const task = ask(model, probe).then((result) => {
      if (result.checked) cache.set(model, { result, until: now() + (result.ok ? OK_TTL_MS : REFUSED_TTL_MS) })
      return result
    }).finally(() => pending.delete(model))
    pending.set(model, task)
    return task
  }

  return { check }
}
