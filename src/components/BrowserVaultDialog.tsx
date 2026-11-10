import { useState, type FormEvent, type KeyboardEvent } from 'react'
import { KeyRound, ShieldCheck } from 'lucide-react'
import type { BrowserVaultRequest } from '../lib/browser-vault'

interface BrowserVaultDialogProps {
  request: BrowserVaultRequest
  botName: string
  onRespond: (id: string, body: Record<string, unknown>) => Promise<void>
}

/** Coffre CDP local : les secrets vont au serveur 4330, jamais dans le WebSocket Hermes. */
export function BrowserVaultDialog({ request, botName, onRespond }: BrowserVaultDialogProps) {
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
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Annulation impossible.'); setPending(false) }
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
      setError(reason instanceof Error ? reason.message : 'Le coffre a refusé la demande.')
      setPending(false)
    }
  }

  return (
    <div className="request-scrim browser-vault-scrim" role="presentation" onKeyDown={onKeyDown}>
      <form className="request-sheet browser-vault-dialog" role="dialog" aria-modal="true" aria-label={saving ? 'Enregistrer un identifiant de site' : 'Code de vérification du navigateur'} autoComplete="off" onSubmit={submit}>
        <div className="request-icon" aria-hidden="true"><KeyRound size={18} /></div>
        <h2>{saving ? `${botName} a besoin de tes identifiants` : `Code demandé par ${botName}`}</h2>
        <p>{saving ? 'Vérifie le site affiché dans le Chrome des bots.' : 'Le code est injecté directement dans la page, sans passer par le bot.'}</p>
        <p className="request-origin">{request.origin}</p>
        {saving && <label>Identifiant du site<input value={identifier} onChange={(event) => setIdentifier(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} required autoFocus disabled={busy} /></label>}
        <label>{saving ? 'Mot de passe du site' : 'Code de vérification'}<input type={saving ? 'password' : 'text'} value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete={saving ? 'new-password' : 'one-time-code'} inputMode={saving ? undefined : 'numeric'} autoCapitalize="none" spellCheck={false} required autoFocus={!saving} disabled={busy} /></label>
        <p className="request-note"><ShieldCheck size={13} />{saving ? `Rangé dans le trousseau de la machine des bots, réservé à ${botName}. Jamais envoyé à Hermes, à la gateway ou au bot.` : 'Aucun code ne reste dans le chat ni dans les journaux.'}</p>
        {error && <p className="request-error" role="alert">{error}</p>}
        <div className="request-actions">
          <button type="button" onClick={() => void cancel()} disabled={busy}>{saving ? 'Plus tard' : 'Passer'}</button>
          <button type="submit" className="is-primary" disabled={busy || !secret.trim() || (saving && !identifier)}>{busy ? 'En cours…' : saving ? 'Enregistrer et continuer' : 'Injecter le code'}</button>
        </div>
      </form>
    </div>
  )
}
