import { useState, type FormEvent, type KeyboardEvent } from 'react'
import { KeyRound, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { BrowserVaultRequest } from '../lib/browser-vault'

interface BrowserVaultDialogProps {
  request: BrowserVaultRequest
  botName: string
  onRespond: (id: string, body: Record<string, unknown>) => Promise<void>
}

/** Local CDP vault: secrets go to the 4330 server, never through the Hermes WebSocket. */
export function BrowserVaultDialog({ request, botName, onRespond }: BrowserVaultDialogProps) {
  const { t } = useTranslation()
  const [identifier, setIdentifier] = useState('')
  const [secret, setSecret] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const saving = request.kind === 'save'
  const busy = pending || request.busy

  const cancel = async () => {
    if (busy) return
    setPending(true)
    setError('')
    try { await onRespond(request.id, { action: 'cancel' }) }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('browserVault.cancelFailed')); setPending(false) }
  }
  const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') void cancel() }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || (saving && (!secret || !identifier)) || (!saving && !secret.trim())) return
    setPending(true)
    setError('')
    try {
      await onRespond(request.id, saving
        ? { action: 'save', identifier, password: secret }
        : { action: 'code', code: secret.trim() })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('browserVault.errors.default'))
      setPending(false)
    }
  }

  return (
    <div className="request-scrim browser-vault-scrim" role="presentation" onKeyDown={onKeyDown}>
      <form className="request-sheet browser-vault-dialog" role="dialog" aria-modal="true" aria-label={saving ? t('browserVault.ariaSave') : t('browserVault.ariaCode')} autoComplete="off" onSubmit={submit}>
        <div className="request-icon" aria-hidden="true"><KeyRound size={18} /></div>
        <h2>{saving ? t('browserVault.titleSave', { bot: botName }) : t('browserVault.titleCode', { bot: botName })}</h2>
        <p>{saving ? t('browserVault.bodySave') : t('browserVault.bodyCode')}</p>
        <p className="request-origin">{request.origin}</p>
        {saving && <label>{t('browserVault.siteIdentifier')}<input value={identifier} onChange={(event) => setIdentifier(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} required autoFocus disabled={busy} /></label>}
        <label>{saving ? t('browserVault.sitePassword') : t('browserVault.verificationCode')}<input type={saving ? 'password' : 'text'} value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete={saving ? 'new-password' : 'one-time-code'} inputMode={saving ? undefined : 'numeric'} autoCapitalize="none" spellCheck={false} required autoFocus={!saving} disabled={busy} /></label>
        <p className="request-note"><ShieldCheck size={13} />{saving ? t('browserVault.noteSave', { bot: botName }) : t('browserVault.noteCode')}</p>
        {error && <p className="request-error" role="alert">{error}</p>}
        <div className="request-actions">
          <button type="button" onClick={() => void cancel()} disabled={busy}>{saving ? t('browserVault.later') : t('browserVault.skip')}</button>
          <button type="submit" className="is-primary" disabled={busy || !secret.trim() || (saving && !identifier)}>{busy ? t('browserVault.busy') : saving ? t('browserVault.saveAndContinue') : t('browserVault.inject')}</button>
        </div>
      </form>
    </div>
  )
}
