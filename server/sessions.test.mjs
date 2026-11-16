import { describe, expect, it } from 'vitest'
import { createSessionStore, credentialsForRestore } from './sessions.mjs'

function memoryPersistence(initial = '[]') {
  const store = { text: initial, saves: 0, failSave: false }
  store.load = () => store.text
  store.save = (text) => {
    if (store.failSave) throw new Error('locked')
    store.text = text
    store.saves += 1
  }
  return store
}

const session = (id, expiresAt) => ({
  id,
  kind: 'local',
  cookies: new Map(),
  cookieHeader: '',
  expiresAt,
})

describe('session store', () => {
  it('starts empty and never saves when the encrypted file cannot be read', () => {
    const logs = []
    const persistence = {
      load: () => { throw new Error('locked') },
      save: () => { throw new Error('should not save') },
    }
    const store = createSessionStore(persistence, { log: (message) => logs.push(message) })
    expect(store.unreadable()).toBe(true)
    expect(store.sessions.size).toBe(0)
    store.sessions.set('id', session('id', Date.now() + 1000))
    expect(store.persist()).toBe(false)
    expect(store.persist()).toBe(false)
    expect(logs).toEqual(['HermesBot: session store unreadable'])
    expect(store.sweepTimer.hasRef()).toBe(false)
    store.stop()
  })

  it('keeps a request successful when save throws, and drops expired sessions', () => {
    const logs = []
    const persistence = memoryPersistence()
    const store = createSessionStore(persistence, { log: (message) => logs.push(message) })
    store.sessions.set('old', session('old', Date.now() - 1000))
    store.sessions.set('new', session('new', Date.now() + 60_000))
    persistence.failSave = true
    expect(store.persist()).toBe(false)
    expect(logs).toEqual(['HermesBot: session store save failed'])
    expect(store.sessions.has('old')).toBe(false)
    persistence.failSave = false
    expect(store.persist()).toBe(true)
    expect(JSON.parse(persistence.text).map((item) => item.id)).toEqual(['new'])
    store.stop()
  })

  it('purges expired sessions on an hourly sweep', async () => {
    const persistence = memoryPersistence()
    const store = createSessionStore(persistence, { sweepMs: 30 })
    store.sessions.set('gone', session('gone', Date.now() - 5))
    store.sessions.set('stay', session('stay', Date.now() + 60_000))
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(store.sessions.has('gone')).toBe(false)
    expect(store.sessions.has('stay')).toBe(true)
    expect(JSON.parse(persistence.text).map((item) => item.id)).toEqual(['stay'])
    store.stop()
  })

  it('restores a readable file and skips sessions that already expired', () => {
    const persistence = memoryPersistence(JSON.stringify([
      { id: 'keep', kind: 'cookie', cookies: { hermes_session: 'value' }, cookieHeader: 'hermes_session=value', expiresAt: Date.now() + 60_000 },
      { id: 'old', kind: 'local', expiresAt: Date.now() - 1000 },
    ]))
    const store = createSessionStore(persistence)
    expect(store.unreadable()).toBe(false)
    expect([...store.sessions.keys()]).toEqual(['keep'])
    expect(store.sessions.get('keep').cookieHeader).toBe('hermes_session=value')
    store.stop()
  })
})

describe('saved credentials', () => {
  it('treats a throwing load as no credential and does not write', () => {
    let writes = 0
    const store = {
      load: () => { throw new Error('locked') },
      save: () => { writes += 1 },
      clear: () => { writes += 1 },
    }
    expect(credentialsForRestore(store)).toEqual({ credentials: null, unreadable: true })
    expect(writes).toBe(0)
    expect(credentialsForRestore({ load: () => 'null' })).toEqual({ credentials: null, unreadable: false })
    expect(credentialsForRestore({ load: () => JSON.stringify({ username: 'user', password: 'secret', provider: 'basic' }) }).credentials.username).toBe('user')
  })
})
