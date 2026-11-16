// Load and unload of an Ollama model for the local chat. One load at a time. The "kept"
// flag is set only after Ollama accepts the load, and a disconnect aborts the upstream call.

export const LOCAL_CHAT_OPTIONS = { num_ctx: 32768 }
export const LOCAL_CHAT_IDLE = '2m'
export const LOCAL_CHAT_KEEP = '30m'
export const LOCAL_CHAT_KEEP_MS = 30 * 60_000

const failure = (message, status) => Object.assign(new Error(message), { status })

export function createLocalMemory({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  const kept = new Map()
  let loadInFlight = false

  return {
    keptModel(model, time = now()) {
      return (kept.get(model) || 0) > time
    },
    touch(model, time = now()) {
      if ((kept.get(model) || 0) > time) kept.set(model, time + LOCAL_CHAT_KEEP_MS)
    },
    async run({ action, model, origin, signal }) {
      const load = action === 'load'
      if (load) {
        if (loadInFlight) throw failure('local_model_busy', 409)
        loadInFlight = true
      }
      const controller = new AbortController()
      const onAbort = () => controller.abort()
      if (signal) {
        if (signal.aborted) controller.abort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
      const timer = setTimeout(() => controller.abort(), load ? 300_000 : 60_000)
      timer.unref?.()
      try {
        const upstream = await fetchImpl(`${origin}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(load
            ? { model, keep_alive: LOCAL_CHAT_KEEP, options: LOCAL_CHAT_OPTIONS }
            : { model, keep_alive: 0 }),
          signal: controller.signal,
        })
        await upstream.text?.().catch(() => '')
        if (!upstream.ok) {
          throw failure(upstream.status === 404 ? 'local_model_missing' : 'local_model_failed', upstream.status === 404 ? 404 : 502)
        }
        if (load) kept.set(model, now() + LOCAL_CHAT_KEEP_MS)
        else kept.delete(model)
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (load) loadInFlight = false
      }
    },
  }
}
