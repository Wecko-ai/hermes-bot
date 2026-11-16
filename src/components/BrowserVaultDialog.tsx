import { useState, type FormEvent } from 'react'
import { ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { BrowserVaultRequest } from '../lib/browser-vault'
import { ssoHint, type SsoProvider } from '../lib/sso'
import { DockedRequestSheet } from './RequestSheet'
import { SsoBanner, SsoChoice, ssoChoices } from './SsoChoice'

interface BrowserVaultDialogProps {
  request: BrowserVaultRequest
  botName: string
  /** Plain-text excerpt of the requesting bot's latest finished reply. */
  context?: string
  onRespond: (id: string, body: Record<string, unknown>) => Promise<void>
}

/** A save that overwrites a login already in the vault. The password itself is never on this object. */
export interface VaultReplace {
  identifier: string
  bots: string[]
}

/** `replaces` is attached by the vault when this save overwrites an existing login. Absent on a first save. */
export function readVaultReplaces(request: BrowserVaultRequest): VaultReplace | null {
  const raw = (request as BrowserVaultRequest & { replaces?: { identifier?: unknown; bots?: unknown } }).replaces
  if (!raw || typeof raw.identifier !== 'string' || !raw.identifier.trim()) return null
  if (!Array.isArray(raw.bots)) return null
  const bots = raw.bots.filter((bot): bot is string => typeof bot === 'string' && bot.length > 0)
  return bots.length ? { identifier: raw.identifier, bots } : null
}

/** Local CDP vault: secrets go to the 4330 server, never through the Hermes WebSocket. */
export function BrowserVaultDialog({ request, botName, context, onRespond }: BrowserVaultDialogProps) {
  const { t } = useTranslation()
  const [identifier, setIdentifier] = useState('')
  const [secret, setSecret] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const kind = request.kind
  const saving = kind === 'save'
  const busy = pending || request.busy

  const cancel = async () => {
    if (busy) return
    setPending(true)
    setError('')
    try { await onRespond(request.id, { action: 'cancel' }) }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('browserVault.cancelFailed')); setPending(false) }
  }
  /** The user signs in to this site with Google (Apple, Microsoft): the bot is told to use that button. */
  const answerSso = async (provider: SsoProvider) => {
    if (busy) return
    setPending(true)
    setError('')
    try { await onRespond(request.id, { action: 'sso', provider }) }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('browserVault.errors.default')); setPending(false) }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    if (kind === 'save' && (!secret || !identifier)) return
    if (kind === 'code' && !secret.trim()) return
    setPending(true)
    setError('')
    try {
      // Sign-up: no secret here, the vault draws the password itself.
      await onRespond(request.id, kind === 'signup'
        ? { action: 'signup' }
        : saving
          ? { action: 'save', identifier, password: secret }
          : { action: 'code', code: secret.trim() })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('browserVault.errors.default'))
      setPending(false)
    }
  }
  const sheet = { botName, site: request.origin, context, className: 'browser-vault-dialog', scrimClassName: 'browser-vault-scrim', onDecline: () => void cancel(), onSubmit: submit }
  const errorLine = error && <p className="request-error" role="alert">{error}</p>

  if (kind === 'signup') {
    const login = request.identifier || ''
    return (
      <DockedRequestSheet {...sheet} ask="signup" className="browser-vault-dialog browser-vault-signup" label={t('browserVault.ariaSignup')} title={t('browserVault.titleSignup', { bot: botName })}>
        <p className="request-lead">{t('browserVault.bodySignup', { bot: botName, origin: request.origin, identifier: login })}</p>
        <p className="request-note"><ShieldCheck size={13} />{t('browserVault.noteSignup', { bot: botName })}</p>
        {errorLine}
        <div className="request-actions">
          <button type="button" onClick={() => void cancel()} disabled={busy}>{t('browserVault.decline')}</button>
          <button type="submit" className="is-primary" disabled={busy} autoFocus>{busy ? t('browserVault.busy') : t('browserVault.createAccount')}</button>
        </div>
      </DockedRequestSheet>
    )
  }

  const sso = saving ? ssoHint(request.sso) : null
  const banner = saving ? <SsoBanner hint={sso} site={request.origin} /> : undefined
  const replaces = saving ? readVaultReplaces(request) : null
  const saveNote = replaces
    ? t('browserVault.noteSaveReplace', {
      bot: botName,
      identifier: replaces.identifier,
      bots: replaces.bots.map((bot) => bot === '*' ? t('vault.allBots') : bot).join(', '),
    })
    : t('browserVault.noteSave', { bot: botName })
  return (
    <DockedRequestSheet {...sheet} ask={saving ? 'login' : 'code'} banner={banner} label={saving ? t('browserVault.ariaSave') : t('browserVault.ariaCode')} title={saving ? t('browserVault.titleSave', { bot: botName }) : t('browserVault.titleCode', { bot: botName })}>
      <p>{saving ? t('browserVault.bodySave') : t('browserVault.bodyCode')}</p>
      {saving && <label>{t('browserVault.siteIdentifier')}<input value={identifier} onChange={(event) => setIdentifier(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} required autoFocus disabled={busy} /></label>}
      <label>{saving ? t('browserVault.sitePassword') : t('browserVault.verificationCode')}<input type={saving ? 'password' : 'text'} value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete={saving ? 'new-password' : 'one-time-code'} inputMode={saving ? undefined : 'numeric'} autoCapitalize="none" spellCheck={false} required autoFocus={!saving} disabled={busy} /></label>
      <p className="request-note"><ShieldCheck size={13} />{saving ? saveNote : t('browserVault.noteCode')}</p>
      {saving && <SsoChoice providers={ssoChoices(sso, request.origin)} disabled={busy} onChoose={(provider) => void answerSso(provider)} />}
      {errorLine}
      <div className="request-actions">
        <button type="button" onClick={() => void cancel()} disabled={busy}>{saving ? t('browserVault.later') : t('browserVault.skip')}</button>
        <button type="submit" className="is-primary" disabled={busy || !secret.trim() || (saving && !identifier)}>{busy ? t('browserVault.busy') : saving ? t('browserVault.saveAndContinue') : t('browserVault.inject')}</button>
      </div>
    </DockedRequestSheet>
  )
}
