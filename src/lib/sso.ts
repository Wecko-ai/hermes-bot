import { i18n } from '../i18n'

/**
 * Federated sign-in ("Continue with Google", Apple, Microsoft). A site the user reaches this way has
 * no password of its own: the login card lets them say so instead of declining without a reason.
 * Mirror of `server/browser-vault/sso.mjs` for the cards.
 */
export const SSO_PROVIDERS = ['google', 'apple', 'microsoft'] as const
export type SsoProvider = (typeof SSO_PROVIDERS)[number]

export const SSO_NAMES: Record<SsoProvider, string> = { google: 'Google', apple: 'Apple', microsoft: 'Microsoft' }

/** What the Chrome vault saw on the page for a `save` request. */
export interface SsoHint {
  provider: SsoProvider
  providers: SsoProvider[]
  hasPasswordField: boolean
  /** The page is the provider's own sign-in page (accounts.google.com…). */
  accountPage?: boolean
}

const ACCOUNT_HOSTS: Record<SsoProvider, string[]> = {
  google: ['accounts.google.com'],
  apple: ['appleid.apple.com', 'idmsa.apple.com'],
  microsoft: ['login.live.com', 'login.microsoftonline.com', 'login.microsoft.com'],
}

export const isSsoProvider = (value: unknown): value is SsoProvider => typeof value === 'string' && (SSO_PROVIDERS as readonly string[]).includes(value)

/** The provider whose own sign-in page this origin (or bare host) is, or null. */
export function accountPageProvider(site?: string): SsoProvider | null {
  if (!site) return null
  let host = ''
  try { host = new URL(site.includes('://') ? site : `https://${site}`).hostname.toLowerCase() } catch { return null }
  return SSO_PROVIDERS.find((provider) => ACCOUNT_HOSTS[provider].includes(host)) || null
}

/** The vault's hint, kept only if it is well formed (it comes from page data). */
export function ssoHint(value: unknown): SsoHint | null {
  if (!value || typeof value !== 'object') return null
  const hint = value as Record<string, unknown>
  const providers = Array.isArray(hint.providers) ? [...new Set(hint.providers.filter(isSsoProvider))] : []
  if (!isSsoProvider(hint.provider) || !providers.length) return null
  return { provider: hint.provider, providers, hasPasswordField: hint.hasPasswordField === true, ...(hint.accountPage === true ? { accountPage: true } : {}) }
}

/** "Google", "Google or Apple": in the interface language. */
export function providerList(providers: readonly SsoProvider[]) {
  const names = providers.map((provider) => SSO_NAMES[provider])
  try { return new Intl.ListFormat(i18n.language, { type: 'disjunction' }).format(names) } catch { return names.join(' / ') }
}

/**
 * Hermes vault (`vault.save_login`): the protocol only allows declining. This note goes to the bot in
 * the same turn with `session.steer`, so the decline has a reason. Read by the model: kept in English.
 */
export function ssoSteerText(provider: SsoProvider, site?: string) {
  const name = SSO_NAMES[provider]
  const where = site ? ` on ${site}` : ''
  return `[HermesBot vault] I declined your login request${where} because I sign in to this site with ${name}, not with a password. Click the site's 'Continue with ${name}' button and pick the account already signed in in this browser. Do not ask me for a password for this site again.`
}
