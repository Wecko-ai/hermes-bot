import { describe, expect, it, vi } from 'vitest'
import { BrowserVaultStore, normalizeOrigin } from './store.mjs'
import { BrowserVaultRequests } from './requests.mjs'

describe('coffre navigateur — stockage', () => {
  it('normalise protocole, hôte et port', () => {
    expect(normalizeOrigin('https://Example.COM:443/login?next=x')).toBe('https://example.com')
    expect(normalizeOrigin('http://example.com:8080/login')).toBe('http://example.com:8080')
    expect(() => normalizeOrigin('file:///tmp/login')).toThrow('invalid_origin')
    expect(() => normalizeOrigin('https://user:pass@example.com')).toThrow('invalid_origin')
  })

  it('ne liste jamais le mot de passe et remplace une entrée par origine', () => {
    let raw = ''
    const store = new BrowserVaultStore({ load: () => raw, save: (value) => { raw = value } })
    store.save('https://example.com/login', 'premier', 'secret-un')
    store.save('https://example.com/autre', 'second', 'secret-deux')
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0].identifier).toBe('second')
    expect(store.list()[0]).not.toHaveProperty('password')
    expect(store.get('https://example.com').password).toBe('secret-deux')
    expect(raw).toContain('secret-deux')
    expect(raw).not.toContain('secret-un')
  })

  it('refuse une origine inconnue et ne persiste pas de secret', () => {
    const save = vi.fn()
    const store = new BrowserVaultStore({ load: () => '', save })
    expect(() => store.get('https://example.com')).toThrow('origin_not_found')
    expect(() => store.save('https://example.com', 'identifiant', '')).toThrow('invalid_credentials')
    expect(save).not.toHaveBeenCalled()
  })

  it('restaure les entrées si l’écriture chiffrée échoue', () => {
    const store = new BrowserVaultStore({ load: () => '', save: () => { throw new Error('disque plein') } })
    expect(() => store.save('https://example.com', 'identifiant', 'secret')).toThrow('vault_write_failed')
    expect(() => store.get('https://example.com')).toThrow('origin_not_found')
  })

  it('refuse un fichier corrompu sans le réécrire', () => {
    const save = vi.fn()
    const store = new BrowserVaultStore({ load: () => '{cassé', save })
    expect(() => store.list()).toThrow('vault_unavailable')
    expect(save).not.toHaveBeenCalled()
  })
})

describe('coffre navigateur — demandes', () => {
  it('publie seulement les métadonnées et résout une annulation', async () => {
    const requests = new BrowserVaultRequests()
    let snapshot = []
    requests.subscribe((value) => { snapshot = value })
    const waiting = requests.create({ kind: 'save', bot: 'orion', origin: 'https://example.com' }, 1000)
    expect(snapshot[0]).toMatchObject({ kind: 'save', bot: 'orion', origin: 'https://example.com', busy: false })
    expect(JSON.stringify(snapshot)).not.toContain('password')
    requests.cancel(snapshot[0].id)
    await expect(waiting).resolves.toMatchObject({ status: 'cancelled' })
    expect(snapshot).toEqual([])
    requests.close()
  })

  it('gèle le timeout pendant une injection déjà validée', async () => {
    vi.useFakeTimers()
    try {
      const requests = new BrowserVaultRequests()
      let snapshot = []
      requests.subscribe((value) => { snapshot = value })
      const waiting = requests.create({ kind: 'code', bot: 'orion', origin: 'https://example.com', targetId: 'onglet' }, 1000)
      requests.setBusy(snapshot[0].id, true)
      await vi.advanceTimersByTimeAsync(5000)
      expect(snapshot).toHaveLength(1)
      requests.complete(snapshot[0].id, { status: 'filled', fields: ['code'] })
      await expect(waiting).resolves.toMatchObject({ status: 'filled' })
      requests.close()
    } finally {
      vi.useRealTimers()
    }
  })
})
