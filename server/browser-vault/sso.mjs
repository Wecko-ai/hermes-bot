import { BrowserVaultError } from './errors.mjs'

/**
 * Federated sign-in ("Continue with Google", Apple, Microsoft). A site the user reaches this way
 * has no password of its own: the vault tells the bot to use that button instead of asking for one.
 */
export const SSO_PROVIDERS = ['google', 'apple', 'microsoft']

export const SSO_NAMES = { google: 'Google', apple: 'Apple', microsoft: 'Microsoft' }

// The providers' own sign-in pages: there, the credentials asked for are the provider account's.
const ACCOUNT_HOSTS = {
  google: ['accounts.google.com'],
  apple: ['appleid.apple.com', 'idmsa.apple.com'],
  microsoft: ['login.live.com', 'login.microsoftonline.com', 'login.microsoft.com'],
}

/** The provider whose own sign-in page this origin is, or null. */
export function accountPageProvider(origin) {
  let host = ''
  try { host = new URL(String(origin || '')).hostname.toLowerCase() } catch { return null }
  return SSO_PROVIDERS.find((provider) => ACCOUNT_HOSTS[provider].includes(host)) || null
}

/**
 * What the card shows, from the origin and the page lookup (`FEDERATED_SIGNIN`, may be null).
 * The page lookup is untrusted page data: only known provider names and a boolean go through.
 */
export function federatedSignIn(origin, page) {
  const own = accountPageProvider(origin)
  const found = Array.isArray(page?.providers) ? page.providers.filter((provider) => SSO_PROVIDERS.includes(provider)) : []
  const providers = own ? [own] : [...new Set(found)]
  if (providers.length === 0) return null
  return {
    provider: providers[0],
    providers,
    hasPasswordField: page?.hasPasswordField === true,
    ...(own ? { accountPage: true } : {}),
  }
}

export function ssoProvider(value) {
  if (typeof value !== 'string' || !SSO_PROVIDERS.includes(value)) throw new BrowserVaultError('invalid_provider', 400)
  return value
}

/** Answer to the bot's `save` when the user signs in to this site with a provider. No password anywhere. */
export function useSsoResult(origin, provider) {
  const name = SSO_NAMES[provider]
  return {
    status: 'use_sso',
    origin,
    provider,
    next: `The user signs in to this site with ${name}: click the site's 'Continue with ${name}' button and pick the account already signed in in this Chrome. Do not ask for a password.`,
  }
}
