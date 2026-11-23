import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const JOB = /^[A-Za-z0-9_-]{1,128}$/
const HOOK = /^[A-Za-z0-9_-]{16,64}$/

/** Cron placeholder for event-only routines (rare natural fire). */
export const EVENT_ONLY_SCHEDULE = '0 0 1 1 *'

export function createRoutineEventStore(dataDir) {
  const dir = path.join(dataDir, 'routine-events')
  const metaPath = path.join(dir, 'triggers.json')
  const secretsPath = path.join(dir, 'secrets.json')
  const runsPath = path.join(dir, 'runs.json')

  async function ensure() {
    await mkdir(dir, { recursive: true, mode: 0o700 })
  }

  async function readJson(file, fallback) {
    try {
      const value = JSON.parse(await readFile(file, 'utf8'))
      return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback
    } catch {
      return fallback
    }
  }

  async function writeJson(file, value) {
    await ensure()
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 })
    await rename(tmp, file)
  }

  async function loadMeta() {
    return readJson(metaPath, { hooks: {}, byJob: {} })
  }

  async function saveMeta(meta) {
    await writeJson(metaPath, meta)
  }

  async function loadSecrets() {
    return readJson(secretsPath, {})
  }

  async function saveSecrets(secrets) {
    await writeJson(secretsPath, secrets)
  }

  async function loadRuns() {
    return readJson(runsPath, { entries: [] })
  }

  async function appendRun(entry) {
    const store = await loadRuns()
    store.entries = [entry, ...store.entries].slice(0, 2000)
    await writeJson(runsPath, store)
  }

  function cleanProfile(profile) {
    return PROFILE.test(profile) ? profile : ''
  }

  function jobKey(profile, jobId) {
    return `${profile}:${jobId}`
  }

  async function getBindingsForProfile(profile) {
    const clean = cleanProfile(profile)
    if (!clean) return {}
    const meta = await loadMeta()
    const out = {}
    for (const [hookId, row] of Object.entries(meta.hooks || {})) {
      if (row?.profile !== clean || !JOB.test(row.jobId)) continue
      out[row.jobId] = { hookId, ...row, secret: undefined }
    }
    return out
  }

  async function getHook(hookId) {
    if (!HOOK.test(hookId)) return null
    const meta = await loadMeta()
    const row = meta.hooks?.[hookId]
    if (!row || !cleanProfile(row.profile) || !JOB.test(row.jobId)) return null
    const secrets = await loadSecrets()
    return { hookId, ...row, secret: typeof secrets[hookId] === 'string' ? secrets[hookId] : '' }
  }

  async function getByJob(profile, jobId) {
    const clean = cleanProfile(profile)
    if (!clean || !JOB.test(jobId)) return null
    const meta = await loadMeta()
    const hookId = meta.byJob?.[jobKey(clean, jobId)]
    if (!hookId) return null
    return getHook(hookId)
  }

  async function upsertBinding({ profile, jobId, trigger, auth = 'bearer', preset = 'generic', emailQuery = '', pollMinutes = 5, hookId, secret }) {
    const clean = cleanProfile(profile)
    if (!clean || !JOB.test(jobId)) throw new Error('invalid_binding')
    if (!['schedule', 'webhook', 'email'].includes(trigger)) throw new Error('invalid_trigger')
    const meta = await loadMeta()
    const secrets = await loadSecrets()
    const key = jobKey(clean, jobId)
    let id = hookId
    if (trigger === 'schedule') {
      if (meta.byJob?.[key]) {
        const old = meta.byJob[key]
        delete meta.hooks?.[old]
        delete secrets[old]
        delete meta.byJob[key]
      }
      await saveSecrets(secrets)
      await saveMeta(meta)
      return null
    }
    if (!HOOK.test(id)) id = undefined
    if (!id) {
      const { randomBytes } = await import('node:crypto')
      id = randomBytes(18).toString('base64url')
    }
    if (!secret || secret.length < 16) {
      const { randomBytes } = await import('node:crypto')
      secret = randomBytes(24).toString('base64url')
    }
    const poll = Math.max(5, Math.min(120, Number(pollMinutes) || 5))
    meta.hooks[id] = {
      profile: clean,
      jobId,
      trigger,
      auth: auth === 'hmac' ? 'hmac' : 'bearer',
      preset: preset === 'github' ? 'github' : 'generic',
      emailQuery: trigger === 'email' ? String(emailQuery || '').slice(0, 500) : '',
      pollMinutes: trigger === 'email' ? poll : 0,
      seenMessageIds: trigger === 'email' ? (meta.hooks[id]?.seenMessageIds || []).slice(0, 500) : [],
      enabled: true,
    }
    meta.byJob = meta.byJob || {}
    const previous = meta.byJob[key]
    if (previous && previous !== id) {
      delete meta.hooks[previous]
      delete secrets[previous]
    }
    meta.byJob[key] = id
    secrets[id] = secret
    await saveSecrets(secrets)
    await saveMeta(meta)
    return { hookId: id, secret, binding: meta.hooks[id] }
  }

  async function regenerateSecret(hookId) {
    const hook = await getHook(hookId)
    if (!hook) return null
    const { randomBytes } = await import('node:crypto')
    const secret = randomBytes(24).toString('base64url')
    const secrets = await loadSecrets()
    secrets[hookId] = secret
    await saveSecrets(secrets)
    return secret
  }

  async function setEnabled(hookId, enabled) {
    const meta = await loadMeta()
    const row = meta.hooks?.[hookId]
    if (!row) return false
    row.enabled = enabled === true
    await saveMeta(meta)
    return true
  }

  async function removeJob(profile, jobId) {
    const hook = await getByJob(profile, jobId)
    if (!hook) return
    const meta = await loadMeta()
    const secrets = await loadSecrets()
    delete meta.hooks[hook.hookId]
    delete meta.byJob?.[jobKey(profile, jobId)]
    delete secrets[hook.hookId]
    await saveSecrets(secrets)
    await saveMeta(meta)
  }

  async function markSeen(hookId, ids) {
    const meta = await loadMeta()
    const row = meta.hooks?.[hookId]
    if (!row || row.trigger !== 'email') return
    const merged = [...new Set([...(row.seenMessageIds || []), ...ids])].slice(-500)
    row.seenMessageIds = merged
    row.lastPollAt = new Date().toISOString()
    await saveMeta(meta)
  }

  async function listRuns(profile, jobId, limit = 20) {
    const clean = cleanProfile(profile)
    if (!clean || !JOB.test(jobId)) return []
    const store = await loadRuns()
    return (store.entries || [])
      .filter((row) => row.profile === clean && row.jobId === jobId)
      .slice(0, limit)
  }

  async function listEmailHooks() {
    const meta = await loadMeta()
    return Object.entries(meta.hooks || {})
      .map(([hookId, row]) => ({ hookId, ...row }))
      .filter((row) => row.trigger === 'email' && row.enabled !== false)
  }

  return {
    EVENT_ONLY_SCHEDULE,
    appendRun,
    getBindingsForProfile,
    getHook,
    getByJob,
    upsertBinding,
    regenerateSecret,
    setEnabled,
    removeJob,
    markSeen,
    listRuns,
    listEmailHooks,
  }
}