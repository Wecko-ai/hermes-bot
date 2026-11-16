import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { BrowserVaultRequest } from '../lib/browser-vault'
import type { ServerRequest } from '../lib/hermes'
import { BrowserVaultDialog } from './BrowserVaultDialog'
import { ServerRequestDialog } from './ServerRequestDialog'

const saveRequest = (extra: Partial<BrowserVaultRequest> = {}): BrowserVaultRequest => ({
  id: 'r1', kind: 'save', bot: 'orion', origin: 'https://login.exemple.org', busy: false, createdAt: '2026-11-16T10:00:00Z', ...extra,
})
const chromeCard = (request: BrowserVaultRequest) => renderToStaticMarkup(<BrowserVaultDialog request={request} botName="Orion" onRespond={async () => undefined} />)
const hermesCard = (params: Record<string, unknown>, onSso?: () => void) => {
  const request: ServerRequest = { id: 's1', method: 'vault.save_login', params: { session_id: 'chat-orion', ...params } }
  return renderToStaticMarkup(<ServerRequestDialog request={request} botName="Orion" onAnswer={() => undefined} onSso={onSso} />)
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, '’').replace(/\s+/g, ' ')

describe('carte du coffre — connexion fédérée', () => {
  it('coffre Chrome, bouton Google vu sur la page : bandeau en haut et un seul bouton', () => {
    const html = chromeCard(saveRequest({ sso: { provider: 'google', providers: ['google'], hasPasswordField: false } }))
    expect(text(html)).toContain('Ce site propose « Continuer avec Google ». La page n’affiche aucun champ de mot de passe.')
    expect(html.indexOf('request-sso-banner')).toBeLessThan(html.indexOf('request-context'))
    expect(text(html)).toContain('Je me connecte avec Google')
    expect(html).not.toContain('>Apple<')
    // The usual login stays possible.
    expect(text(html)).toContain('Mot de passe du site')
    expect(text(html)).toContain('Enregistrer et continuer')
  })

  it('coffre Chrome, Google et Apple vus : choix entre les deux seulement', () => {
    const html = chromeCard(saveRequest({ sso: { provider: 'google', providers: ['google', 'apple'], hasPasswordField: true } }))
    expect(text(html)).toContain('Ce site propose « Continuer avec Google ou Apple ».')
    expect(text(html)).not.toContain('aucun champ de mot de passe')
    expect(html).toContain('>Google<')
    expect(html).toContain('>Apple<')
    expect(html).not.toContain('>Microsoft<')
    expect(html).toContain('aria-label="Je me connecte avec Apple"')
  })

  it('coffre Chrome, rien vu : pas de bandeau, choix Google, Apple, Microsoft', () => {
    const html = chromeCard(saveRequest())
    expect(html).not.toContain('request-sso-banner')
    expect(text(html)).toContain('Pas de mot de passe pour ce site ? Je me connecte avec Google Apple Microsoft')
  })

  it('accounts.google.com : le compte Google lui-même, sans bouton fédéré', () => {
    const html = chromeCard(saveRequest({ origin: 'https://accounts.google.com', sso: { provider: 'google', providers: ['google'], hasPasswordField: true, accountPage: true } }))
    expect(text(html)).toContain('C’est la page de connexion du compte Google lui-même (accounts.google.com) : l’identifiant et le mot de passe demandés sont ceux de ton compte Google.')
    expect(html).not.toContain('request-sso-button')
  })

  it('code et création de compte : aucun bouton fédéré', () => {
    expect(chromeCard(saveRequest({ kind: 'code' }))).not.toContain('request-sso')
    expect(chromeCard(saveRequest({ kind: 'signup', identifier: 'orion@exemple.org' }))).not.toContain('request-sso')
  })

  it('coffre de Hermes : choix des trois fournisseurs, rien sans gestionnaire', () => {
    const html = hermesCard({ origin: 'https://login.exemple.org', site: 'login.exemple.org' }, () => undefined)
    expect(text(html)).toContain('Je me connecte avec Google Apple Microsoft')
    expect(html).not.toContain('request-sso-banner')
    expect(hermesCard({ origin: 'https://login.exemple.org' })).not.toContain('request-sso')
  })

  it('coffre de Hermes sur accounts.google.com : bandeau du compte Google, pas de bouton', () => {
    const html = hermesCard({ origin: 'https://accounts.google.com', site: 'accounts.google.com' }, () => undefined)
    expect(text(html)).toContain('C’est la page de connexion du compte Google lui-même (accounts.google.com)')
    expect(html).not.toContain('request-sso-button')
  })
})
