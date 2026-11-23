import fs from 'node:fs/promises'
import path from 'node:path'

const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const KEEP_DAYS = 90

function dayStamp(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function dayFile(logDir, day) {
  return path.join(logDir, `routing-${day}.jsonl`)
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
}

export async function rotateOldLogs(logDir, now = new Date()) {
  await ensureDir(logDir)
  const archive = path.join(logDir, 'archive')
  await ensureDir(archive)
  let names = []
  try {
    names = await fs.readdir(logDir)
  } catch {
    return
  }
  const cutoff = now.getTime() - KEEP_DAYS * 86_400_000
  for (const name of names) {
    if (!/^routing-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue
    const file = path.join(logDir, name)
    const stat = await fs.stat(file)
    if (stat.mtimeMs < cutoff) {
      await fs.rename(file, path.join(archive, name))
    }
  }
}

/** @param {object} entry — must never include prompt text or secrets */
export async function appendRoutingLog(logDir, entry) {
  if (!entry || typeof entry !== 'object') throw new Error('invalid_entry')
  await rotateOldLogs(logDir)
  const file = dayFile(logDir, dayStamp(new Date()))
  const line = `${JSON.stringify({ v: 1, ...entry })}\n`
  await fs.appendFile(file, line, { mode: 0o600 })
  try {
    await fs.chmod(file, 0o600)
  } catch { /* best effort */ }
}

export function sanitizeLogEntry(body) {
  const bot = typeof body.bot === 'string' && PROFILE.test(body.bot) ? body.bot : null
  const sessionId = typeof body.sessionId === 'string' && body.sessionId.length <= 128 ? body.sessionId : null
  const category = typeof body.category === 'string' ? body.category : null
  const chosen = typeof body.chosen === 'string' ? body.chosen.slice(0, 192) : null
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 240) : null
  const candidates = Array.isArray(body.candidates)
    ? body.candidates.slice(0, 16).map((row) => ({
      model: typeof row?.model === 'string' ? row.model.slice(0, 192) : null,
      score: typeof row?.score === 'number' && Number.isFinite(row.score) ? row.score : null,
    }))
    : []
  const fallbacks = Array.isArray(body.fallbacks)
    ? body.fallbacks.slice(0, 4).map((row) => ({
      model: typeof row?.model === 'string' ? row.model.slice(0, 192) : null,
      error: typeof row?.error === 'string' ? row.error.slice(0, 64) : null,
    }))
    : []
  const mode = body.mode === 'auto-free' ? 'auto-free' : 'auto'
  const ts = typeof body.ts === 'string' ? body.ts : new Date().toISOString()
  const triageSource = ['rules', 'local', 'local-shadow', 'local-timeout', 'local-error'].includes(body.triageSource)
    ? body.triageSource
    : (body.triage && typeof body.triage === 'object' && ['rules', 'local', 'local-shadow', 'local-timeout', 'local-error'].includes(body.triage.source)
      ? body.triage.source
      : null)
  const triage = body.triage && typeof body.triage === 'object' ? body.triage : {}
  const rulesCategory = typeof body.rulesCategory === 'string' ? body.rulesCategory
    : (typeof triage.rulesCategory === 'string' ? triage.rulesCategory : null)
  const difficulty = ['easy', 'medium', 'hard'].includes(body.difficulty) ? body.difficulty
    : (['easy', 'medium', 'hard'].includes(triage.difficulty) ? triage.difficulty : null)
  const triageLatencyMs = typeof body.triageLatencyMs === 'number' && Number.isFinite(body.triageLatencyMs) ? body.triageLatencyMs
    : (typeof triage.latencyMs === 'number' && Number.isFinite(triage.latencyMs) ? triage.latencyMs : null)
  const confidence = typeof body.confidence === 'number' && Number.isFinite(body.confidence) ? body.confidence
    : (typeof triage.confidence === 'number' && Number.isFinite(triage.confidence) ? triage.confidence : null)
  return {
    ts,
    mode,
    bot,
    sessionId,
    category,
    chosen,
    reason,
    candidates,
    fallbacks,
    tokensIn: typeof body.tokensIn === 'number' ? body.tokensIn : null,
    tokensOut: typeof body.tokensOut === 'number' ? body.tokensOut : null,
    costUsd: typeof body.costUsd === 'number' ? body.costUsd : null,
    latencyMs: typeof body.latencyMs === 'number' ? body.latencyMs : null,
    outcome: ['ok', 'error', 'cancelled'].includes(body.outcome) ? body.outcome : null,
    triageSource,
    triageLatencyMs,
    rulesCategory,
    difficulty,
    confidence,
  }
}

async function readJsonl(file) {
  try {
    const text = await fs.readFile(file, 'utf8')
    return text.split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
  } catch {
    return []
  }
}

export async function readRoutingLog(logDir, days = 7) {
  const span = Math.min(Math.max(1, Number(days) || 7), 90)
  const entries = []
  const now = new Date()
  for (let i = 0; i < span; i += 1) {
    const d = new Date(now.getTime() - i * 86_400_000)
    const file = dayFile(logDir, dayStamp(d))
    entries.push(...await readJsonl(file))
  }
  return entries
}

export function summarizeRoutingLog(entries) {
  const byModel = new Map()
  let fallbacks = 0
  let costUsd = 0
  for (const row of entries) {
    const model = row.chosen
    if (model) {
      const current = byModel.get(model) || { model, count: 0, errors: 0 }
      current.count += 1
      if (row.outcome === 'error') current.errors += 1
      byModel.set(model, current)
    }
    if (Array.isArray(row.fallbacks) && row.fallbacks.length) fallbacks += row.fallbacks.length
    if (typeof row.costUsd === 'number') costUsd += row.costUsd
  }
  return {
    total: entries.length,
    fallbacks,
    costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
    byModel: [...byModel.values()].sort((a, b) => b.count - a.count),
  }
}

/** Rolling mean latency per model from recent log lines (no prompt text). */
export function latencyAverages(entries, window = 200) {
  const buckets = new Map()
  for (const row of entries.slice(-window)) {
    const model = row.chosen
    const ms = row.latencyMs
    if (!model || typeof ms !== 'number' || !Number.isFinite(ms)) continue
    const list = buckets.get(model) || []
    list.push(ms)
    buckets.set(model, list)
  }
  const out = new Map()
  for (const [model, list] of buckets) {
    out.set(model, list.reduce((a, b) => a + b, 0) / list.length)
  }
  return out
}