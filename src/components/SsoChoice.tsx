import { Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { accountPageProvider, providerList, SSO_NAMES, SSO_PROVIDERS, type SsoHint, type SsoProvider } from '../lib/sso'

/**
 * Top of a login card: the site offers "Continue with Google" (seen on the page by the Chrome vault),
 * or the page is the provider's own sign-in page, where the credentials asked for are that account's.
 */
export function SsoBanner({ hint, site }: { hint?: SsoHint | null; site?: string }) {
  const { t } = useTranslation()
  const own = hint?.accountPage ? hint.provider : accountPageProvider(site)
  if (own) {
    let host = site || ''
    try { host = new URL(host).host || host } catch { /* bare host already */ }
    return <p className="request-sso-banner is-account" role="note"><Info size={14} aria-hidden="true" /><span>{t('vaultSso.accountPage', { provider: SSO_NAMES[own], host })}</span></p>
  }
  if (!hint) return null
  return (
    <p className="request-sso-banner" role="note">
      <Info size={14} aria-hidden="true" />
      <span>{t('vaultSso.offered', { providers: providerList(hint.providers) })}{!hint.hasPasswordField && ` ${t('vaultSso.noPasswordField')}`}</span>
    </p>
  )
}

/** The providers to offer: the ones seen on the page, all three otherwise; none on a provider's own page. */
export function ssoChoices(hint: SsoHint | null | undefined, site?: string): SsoProvider[] {
  if (hint?.accountPage || accountPageProvider(site)) return []
  return hint?.providers.length ? hint.providers : [...SSO_PROVIDERS]
}

/** "I sign in with Google": one button for a single provider, a choice otherwise. */
export function SsoChoice({ providers, disabled, onChoose }: { providers: SsoProvider[]; disabled?: boolean; onChoose: (provider: SsoProvider) => void }) {
  const { t } = useTranslation()
  if (!providers.length) return null
  const single = providers.length === 1
  return (
    <div className="request-sso" role="group" aria-label={t('vaultSso.question')}>
      <span className="request-sso-question">{t('vaultSso.question')}</span>
      <div className="request-sso-buttons">
        {!single && <span className="request-sso-with">{t('vaultSso.useWith')}</span>}
        {providers.map((provider) => (
          <button key={provider} type="button" className="request-sso-button" disabled={disabled}
            aria-label={t('vaultSso.useOne', { provider: SSO_NAMES[provider] })}
            title={t('vaultSso.buttonTitle', { provider: SSO_NAMES[provider] })}
            onClick={() => onChoose(provider)}>
            {single ? t('vaultSso.useOne', { provider: SSO_NAMES[provider] }) : SSO_NAMES[provider]}
          </button>
        ))}
      </div>
    </div>
  )
}
