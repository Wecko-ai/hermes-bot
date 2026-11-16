// Signed-in sessions, persisted by the desktop app. `load()` throws when the encrypted
// file exists but cannot be read: the store then stays empty and is never written over.
// A failed `save()` is logged and swallowed so the request that just succeeded stays successful.

const HOUR_MS = 60 * 60 * 1000

function sessionRecord(session) {
  return {
    id: session.id,
    kind: session.kind,
    cookies: Object.fromEntries(session.cookies),
    cookieHeader: session.cookieHeader,
    expiresAt: session.expiresAt,
  }
}

export function createSessionStore(persistence, { now = () => Date.now(), log = console.error, sweepMs = HOUR_MS } = {}) {
  const sessions = new Map()
  let unreadable = false
  let loggedUnreadable = false

  const logUnreadable = () => {
    if (loggedUnreadable) return
    loggedUnreadable = true
    log('HermesBot: session store unreadable')
  }

  function purgeExpired() {
    const time = now()
    let removed = 0
    for (const [id, session] of sessions) {
      if (!(session?.expiresAt > time)) {
        sessions.delete(id)
        removed += 1
      }
    }
    return removed
  }

  function persist() {
    if (!persistence) return false
    if (unreadable) {
      logUnreadable()
      return false
    }
    purgeExpired()
    try {
      persistence.save(JSON.stringify([...sessions.values()].map(sessionRecord)))
      return true
    } catch {
      log('HermesBot: session store save failed')
      return false
    }
  }

  function restore() {
    if (!persistence) return
    let text
    try {
      text = persistence.load()
    } catch {
      unreadable = true
      sessions.clear()
      logUnreadable()
      return
    }
    try {
      const records = JSON.parse(text || '[]')
      if (!Array.isArray(records)) return
      const time = now()
      for (const record of records) {
        if (!record || typeof record.id !== 'string') continue
        const kind = record.kind === 'local' ? 'local' : 'cookie'
        if (kind === 'cookie' && typeof record.cookieHeader !== 'string') continue
        if (!Number.isFinite(record.expiresAt) || record.expiresAt <= time) continue
        const cookies = new Map(kind === 'local' ? [] : Object.entries(record.cookies || {}).filter(([, value]) => typeof value === 'string'))
        sessions.set(record.id, {
          id: record.id,
          kind,
          cookies,
          cookieHeader: kind === 'local' ? '' : record.cookieHeader,
          expiresAt: record.expiresAt,
        })
      }
    } catch {
      // Old or corrupt text is not an unreadable file: a later save may replace it.
    }
  }

  restore()
  const sweepTimer = setInterval(() => {
    if (purgeExpired()) persist()
  }, sweepMs)
  sweepTimer.unref()

  return {
    sessions,
    persist,
    purgeExpired,
    unreadable: () => unreadable,
    sweepTimer,
    stop: () => clearInterval(sweepTimer),
  }
}

/** What `/api/auth/restore` may use. A throwing load is "nothing saved" and must not be overwritten. */
export function credentialsForRestore(store) {
  if (!store) return { credentials: null, unreadable: false }
  try {
    const saved = JSON.parse(store.load() || 'null')
    const credentials = typeof saved?.username === 'string' && typeof saved?.password === 'string' ? saved : null
    return { credentials, unreadable: false }
  } catch {
    return { credentials: null, unreadable: true }
  }
}
