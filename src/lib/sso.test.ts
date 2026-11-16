import { describe, expect, it } from 'vitest'
import { accountPageProvider, providerList, ssoHint, ssoSteerText } from './sso'

describe('connexion fédérée — interface', () => {
  it('reconnaît la page du fournisseur lui-même, origine ou hôte nu', () => {
    expect(accountPageProvider('https://accounts.google.com')).toBe('google')
    expect(accountPageProvider('accounts.google.com')).toBe('google')
    expect(accountPageProvider('https://idmsa.apple.com')).toBe('apple')
    expect(accountPageProvider('https://login.microsoftonline.com')).toBe('microsoft')
    expect(accountPageProvider('https://login.exemple.org')).toBeNull()
    expect(accountPageProvider('https://accounts.google.com.evil.example')).toBeNull()
    expect(accountPageProvider(undefined)).toBeNull()
  })

  it('ne garde de l’indice du coffre que des fournisseurs connus', () => {
    expect(ssoHint({ provider: 'google', providers: ['google', 'x', 'google'], hasPasswordField: true })).toEqual({ provider: 'google', providers: ['google'], hasPasswordField: true })
    expect(ssoHint({ provider: 'apple', providers: ['apple'], hasPasswordField: 1, accountPage: true })).toEqual({ provider: 'apple', providers: ['apple'], hasPasswordField: false, accountPage: true })
    expect(ssoHint({ provider: 'facebook', providers: ['facebook'] })).toBeNull()
    expect(ssoHint({ provider: 'google', providers: [] })).toBeNull()
    expect(ssoHint('google')).toBeNull()
    expect(ssoHint(undefined)).toBeNull()
  })

  it('liste les fournisseurs dans la langue de l’interface', () => {
    expect(providerList(['google'])).toBe('Google')
    expect(providerList(['google', 'apple'])).toBe('Google ou Apple')
  })

  it('consigne pour le bot : le fournisseur, le bouton à cliquer, ne plus demander de mot de passe', () => {
    const text = ssoSteerText('google', 'https://login.exemple.org')
    expect(text).toContain('https://login.exemple.org')
    expect(text).toContain("Click the site's 'Continue with Google' button")
    expect(text).toContain('Do not ask me for a password for this site again.')
    expect(ssoSteerText('microsoft')).toContain("'Continue with Microsoft'")
    expect(ssoSteerText('microsoft')).not.toContain(' on ')
  })
})
