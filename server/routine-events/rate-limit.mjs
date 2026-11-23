const hits = new Map()
const dedupe = new Map()

export function rateLimit(key, { windowMs = 60_000, max = 20 } = {}) {
  const now = Date.now()
  const bucket = hits.get(key) || []
  const recent = bucket.filter((at) => now - at < windowMs)
  if (recent.length >= max) return false
  recent.push(now)
  hits.set(key, recent)
  return true
}

export function dedupeRecent(key, { windowMs = 60_000 } = {}) {
  const now = Date.now()
  const at = dedupe.get(key)
  if (at && now - at < windowMs) return false
  dedupe.set(key, now)
  return true
}

export function resetRateLimitState() {
  hits.clear()
  dedupe.clear()
}