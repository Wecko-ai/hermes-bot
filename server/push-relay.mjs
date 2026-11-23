import { execFile } from 'node:child_process'
import path from 'node:path'

const SECRET_OUTPUT_MAX_BYTES = 4096
const SECRET_COMMAND_TIMEOUT_MS = 15_000
const DEFAULT_DEBOUNCE_MS = 2_500
const TITLE_MAX = 120
const BODY_MAX = 200

function execSecret(command, timeout = SECRET_COMMAND_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(command[0], command.slice(1), {
      timeout,
      maxBuffer: SECRET_OUTPUT_MAX_BYTES,
      windowsHide: true,
      shell: false,
    }, (error, stdout) => resolve(error ? '' : String(stdout || '').trim()))
  })
}

function validCommand(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 32
    && value.every((argument) => typeof argument === 'string' && argument.trim().length > 0 && argument.length <= 128)
    && path.isAbsolute(value[0]) ? value : null
}

function relayOrigin(relayUrl) {
  const text = typeof relayUrl === 'string' ? relayUrl.trim() : ''
  if (!text) return ''
  try {
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return url.origin
  } catch {
    return ''
  }
}

function clip(text, max) {
  const line = String(text || '').replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function createPushRelay({
  relayUrl = '',
  secretCommand = null,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  fetchImpl = fetch,
  readCommand = execSecret,
  now = Date.now,
} = {}) {
  const origin = relayOrigin(relayUrl)
  const command = validCommand(secretCommand)
  let windowInFront = false
  const pending = new Map()
  let secretCache = { at: 0, value: '' }

  async function secret() {
    if (!command) return ''
    const age = now() - secretCache.at
    if (secretCache.value && age < 60_000) return secretCache.value
    const value = clip(await readCommand(command), 512)
    secretCache = { at: now(), value }
    return value
  }

  function setWindowInFront(value) {
    windowInFront = value === true
  }

  function disabled() {
    return !origin
  }

  function cancelPending() {
    for (const entry of pending.values()) clearTimeout(entry.timer)
    pending.clear()
  }

  async function sendToRelay(payload) {
    const token = await secret()
    if (!token) return { ok: false, reason: 'secret_unavailable' }
    const url = new URL('/v1/notify', origin)
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })
      await response.body?.cancel?.().catch(() => {})
      return { ok: response.ok, status: response.status }
    } catch {
      return { ok: false, reason: 'network_error' }
    }
  }

  async function flushEntry(slug) {
    const entry = pending.get(slug)
    if (!entry) return { ok: false, reason: 'missing' }
    pending.delete(slug)
    if (windowInFront) return { ok: true, skipped: 'window_in_front' }
    const body = {
      account_id: entry.accountId,
      title: clip(entry.title, TITLE_MAX),
      body: clip(entry.body, BODY_MAX),
      slug: entry.slug,
      thread: entry.slug,
    }
    return sendToRelay(body)
  }

  function scheduleFlush(slug) {
    const entry = pending.get(slug)
    if (!entry) return
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      void flushEntry(slug)
    }, debounceMs)
  }

  /**
   * Queue an iPhone push. Coalesces by `slug` within the debounce window (latest title/body wins).
   * Returns immediately; relay errors are not thrown (no logging of secrets or full bodies).
   */
  function enqueue({ accountId, slug, title, body }) {
    if (disabled()) return { ok: true, skipped: 'relay_off' }
    const id = typeof accountId === 'string' ? accountId.trim() : ''
    const bot = typeof slug === 'string' ? slug.trim() : ''
    if (!id || !bot) return { ok: false, reason: 'invalid_payload' }
    const key = bot
    const current = pending.get(key)
    pending.set(key, {
      accountId: id,
      slug: bot,
      title: clip(title, TITLE_MAX) || 'HermesBot',
      body: clip(body, BODY_MAX),
      timer: current?.timer,
    })
    scheduleFlush(key)
    return { ok: true, queued: true }
  }

  return {
    disabled,
    setWindowInFront,
    enqueue,
    flushNow: flushEntry,
    cancelPending,
    _pendingSize: () => pending.size,
  }
}