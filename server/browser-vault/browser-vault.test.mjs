import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { normalizeOrigin } from './store.mjs'
import { attributeValue, botAllowed, KeychainStore, parseDump, passwordValue, runSecurity, validBots } from './keychain.mjs'
import { BrowserVaultRequests } from './requests.mjs'

const darwin = process.platform === 'darwin' && existsSync('/usr/bin/security')

describe('coffre navigateur — trousseau', () => {
  it('normalise protocole, hôte et port', () => {
    expect(normalizeOrigin('https://Example.COM:443/login?next=x')).toBe('https://example.com')
    expect(normalizeOrigin('http://example.com:8080/login')).toBe('http://example.com:8080')
    expect(() => normalizeOrigin('file:///tmp/login')).toThrow('invalid_origin')
    expect(() => normalizeOrigin('https://user:pass@example.com')).toThrow('invalid_origin')
  })

  it('lit les sorties de security : texte brut, hexadécimal, entiers', () => {
    expect(attributeValue('<NULL>')).toBeNull()
    expect(attributeValue('"{"bots":["orion"]}"')).toBe('{"bots":["orion"]}')
    expect(attributeValue('0xC3A96C697365  "\\303\\251lise"')).toBe('élise')
    expect(passwordValue('password: "deadbeef"\n')).toBe('deadbeef')
    expect(passwordValue('password: 0xC3A9225C  "\\303\\251\\"\\134"')).toBe('é"\\')
    expect(passwordValue('password:\n')).toBe('')
    expect(passwordValue('autre chose')).toBeNull()
    const items = parseDump([
      'keychain: "/x.keychain-db"', 'class: "inet"', 'attributes:',
      '    "acct"<blob>="orion@exemple.com"', '    "crtr"<uint32>="HBot"', '    "port"<uint32>=0x00001F90 ',
      '    "ptcl"<uint32>="http"', '    "srvr"<blob>="app.exemple.org"',
      'keychain: "/x.keychain-db"', 'class: "genp"', 'attributes:', '    "acct"<blob>="x"',
    ].join('\n'))
    expect(items).toHaveLength(1)
    expect(items[0].attributes).toMatchObject({ acct: 'orion@exemple.com', crtr: 'HBot', port: 8080, ptcl: 'http' })
  })

  it('refuse des bots invalides et les fins de ligne, avant tout appel à security', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }))
    const store = new KeychainStore({ keychain: '/x.keychain-db', run })
    expect(() => validBots([])).toThrow('invalid_bots')
    expect(() => validBots(['../x'])).toThrow('invalid_bots')
    expect(validBots(['vega', 'orion', '*'])).toEqual(['*'])
    expect(botAllowed({ bots: ['orion'] }, 'vega')).toBe(false)
    await expect(store.save('https://exemple.com', 'a\nb', 'secret', ['orion'])).rejects.toThrow('invalid_credentials')
    await expect(store.save('https://exemple.com', 'a', 'se\ncret', ['orion'])).rejects.toThrow('invalid_credentials')
    expect(run).not.toHaveBeenCalled()
  })

  it.skipIf(!darwin)('range, liste, relit et retire dans un vrai trousseau, mot de passe jamais en argument', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'hermesbot-keychain-'))
    const keychain = path.join(directory, 'test.keychain-db')
    const calls = []
    const run = (args, input) => { calls.push(args); return runSecurity(args, input) }
    try {
      for (const args of [['create-keychain', '-p', 'test', keychain], ['unlock-keychain', '-p', 'test', keychain], ['set-keychain-settings', keychain]]) {
        expect((await runSecurity(args)).code).toBe(0)
      }
      const store = new KeychainStore({ keychain, run })
      const secret = String.raw`a b"c\d$e'f é ;x`
      await store.save('https://www.exemple.com/login', 'élise@exemple.com', secret, ['orion'])
      await store.save('http://app.exemple.org:8080', 'u2', 'deadbeef', ['*'])
      expect((await store.list('orion')).map((entry) => entry.origin)).toEqual(['http://app.exemple.org:8080', 'https://www.exemple.com'])
      expect((await store.list('vega')).map((entry) => entry.origin)).toEqual(['http://app.exemple.org:8080'])
      expect(JSON.stringify(await store.list())).not.toContain('deadbeef')
      expect((await store.get('https://www.exemple.com')).password).toBe(secret)
      await store.save('https://www.exemple.com', 'autre@exemple.com', undefined, ['orion', 'vega'])
      expect(await store.get('https://www.exemple.com')).toMatchObject({ identifier: 'autre@exemple.com', password: secret, bots: ['orion', 'vega'] })
      expect(await store.list()).toHaveLength(2)
      await store.remove('http://app.exemple.org:8080')
      await expect(store.get('http://app.exemple.org:8080')).rejects.toThrow('origin_not_found')
      expect(calls.flat().some((value) => value.includes('deadbeef') || value.includes(secret))).toBe(false)
    } finally {
      await runSecurity(['delete-keychain', keychain])
      rmSync(directory, { recursive: true, force: true })
    }
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
