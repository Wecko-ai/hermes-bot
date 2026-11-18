import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutoSignupSetting, ShareCredentialsSetting } from '../components/VaultTab'
import { getVaultSettings, saveVaultSettings, takeUnseenNotices, type BrowserVaultNotice } from './browser-vault'

const notice = (id: string): BrowserVaultNotice => ({
  id, kind: 'auto_signup', bot: 'orion', origin: 'https://www.tradingview.com', identifier: 'orion@exemple.org', at: '2026-11-16T10:00:00Z',
})

const memoryStorage = () => {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
}

describe('coffre — réglage « Créer les comptes sans me demander »', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('s’affiche dans Réglages > Coffre, coupé et verrouillé tant que le coffre n’a pas répondu', () => {
    const html = renderToStaticMarkup(createElement(AutoSignupSetting, { checked: false, disabled: true, onChange: () => undefined }))
    expect(html).toContain('Créer les comptes sans me demander')
    expect(html).toContain('Les demandes d’identifiants et de codes gardent leur carte.')
    expect(html).toContain('role="switch"')
    expect(html).not.toContain('checked=""')
    expect(html).toContain('disabled=""')
    const on = renderToStaticMarkup(createElement(AutoSignupSetting, { checked: true, disabled: false, onChange: () => undefined }))
    expect(on).toContain('checked=""')
    expect(on).not.toContain('disabled=""')
  })

  it('affiche le partage des identifiants, coupé et verrouillé tant que le coffre n’a pas répondu', () => {
    const html = renderToStaticMarkup(createElement(ShareCredentialsSetting, { checked: false, disabled: true, onChange: () => undefined }))
    expect(html).toContain('Partager les identifiants entre tous les bots')
    expect(html).toContain('Un identifiant donné à un bot sert à tous')
    expect(html).toContain('disabled=""')
    expect(renderToStaticMarkup(createElement(ShareCredentialsSetting, { checked: true, disabled: false, onChange: () => undefined }))).toContain('checked=""')
  })

  it('s’enregistre auprès du coffre et rend ce que le coffre a gardé', async () => {
    const fetch = vi.fn(async (_path: string, init?: RequestInit) => new Response(JSON.stringify({ settings: { autoSignup: init?.method === 'POST' } }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    expect(await getVaultSettings()).toEqual({ autoSignup: false, shareCredentials: false })
    expect(fetch.mock.calls[0][0]).toBe('/api/browser-vault/settings')
    expect(fetch.mock.calls[0][1]?.method).toBe('GET')
    expect(await saveVaultSettings({ autoSignup: true })).toEqual({ autoSignup: true, shareCredentials: false })
    expect(fetch.mock.calls[1][0]).toBe('/api/browser-vault/settings')
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ autoSignup: true }) })
  })

  it('refus du coffre : message lisible, rien de supposé', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'user_session_required' }), { status: 403 })))
    await expect(saveVaultSettings({ autoSignup: true })).rejects.toThrow('Session Hermes expirée : reconnecte-toi pour modifier le coffre.')
  })

  it('réponse inattendue du coffre : désactivé', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ settings: { autoSignup: 'true', shareCredentials: 1 } }), { status: 200 })))
    expect(await getVaultSettings()).toEqual({ autoSignup: false, shareCredentials: false })
  })
})

describe('coffre — compte créé sans carte, prévenu une fois', () => {
  it('ne montre chaque notification qu’une fois, même après un rechargement', () => {
    const storage = memoryStorage()
    expect(takeUnseenNotices([notice('a')], storage).map((item) => item.id)).toEqual(['a'])
    expect(takeUnseenNotices([notice('a')], storage)).toEqual([])
    expect(takeUnseenNotices([notice('a'), notice('b')], storage).map((item) => item.id)).toEqual(['b'])
  })

  it('stockage illisible : montre ce que le coffre connaît encore, sans planter', () => {
    const storage = { getItem: () => '{cassé', setItem: () => { throw new Error('plein') } }
    expect(takeUnseenNotices([notice('a')], storage).map((item) => item.id)).toEqual(['a'])
  })
})
