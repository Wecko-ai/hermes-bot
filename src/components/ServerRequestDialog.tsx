import { useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { KeyRound, ShieldCheck } from 'lucide-react'
import type { ServerRequest } from '../lib/hermes'

const text = (value: unknown) => (typeof value === 'string' ? value : '')
export const CHOICE_LABELS: Record<string, string> = {
  once: 'Autoriser une fois',
  session: 'Pour cette session',
  always: 'Toujours autoriser',
  deny: 'Refuser',
}

interface ServerRequestDialogProps {
  request: ServerRequest
  botName: string
  onAnswer: (id: string, result: Record<string, unknown>) => void
}

function Sheet({ title, children, onDecline, onSubmit }: { title: string; children: ReactNode; onDecline: () => void; onSubmit?: (event: FormEvent) => void }) {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') onDecline()
  }
  return (
    <div className="request-scrim" role="presentation" onKeyDown={onKeyDown}>
      <form className="request-sheet" role="dialog" aria-modal="true" aria-label={title} autoComplete="off" onSubmit={onSubmit ?? ((event) => event.preventDefault())}>
        <div className="request-icon" aria-hidden="true"><KeyRound size={18} /></div>
        <h2>{title}</h2>
        {children}
      </form>
    </div>
  )
}

/**
 * Demandes que la gateway adresse à l’utilisateur pendant un tour : coffre d’identifiants et accords.
 * Le mot de passe ne vit que dans l’état de ce composant, démonté dès la réponse.
 */
export function ServerRequestDialog({ request, botName, onAnswer }: ServerRequestDialogProps) {
  const [identifier, setIdentifier] = useState('')
  const [secret, setSecret] = useState('')
  const { id, method, params } = request
  const answerValue = (value: string) => onAnswer(id, { value })
  const submit = (value: string) => (event: FormEvent) => {
    event.preventDefault()
    answerValue(value)
  }

  if (method === 'approval') {
    const choices = Array.isArray(params.choices) && params.choices.length ? params.choices.filter((choice): choice is string => typeof choice === 'string') : ['once', 'deny']
    const command = text(params.command)
    return (
      <Sheet title={`${botName} demande ton accord`} onDecline={() => onAnswer(id, { choice: 'deny' })}>
        <p>{text(params.description) || 'Cette action demande une approbation.'}</p>
        {command && <pre className="request-command">{command}</pre>}
        <div className="request-actions is-wrap">
          {[...choices].reverse().map((choice) => (
            <button key={choice} type="button" className={choice === 'once' ? 'is-primary' : ''} autoFocus={choice === 'deny'} onClick={() => onAnswer(id, { choice })}>{CHOICE_LABELS[choice] || choice}</button>
          ))}
        </div>
      </Sheet>
    )
  }

  if (method === 'vault.save_login') {
    const origin = text(params.origin)
    return (
      <Sheet title={`${botName} a besoin de tes identifiants`} onDecline={() => answerValue('')} onSubmit={submit(JSON.stringify({ identifier, password: secret }))}>
        <p>Vérifie que c’est le bon site avant de continuer.</p>
        <p className="request-origin">{origin || text(params.site)}</p>
        <label>Identifiant du site<input value={identifier} onChange={(event) => setIdentifier(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} required autoFocus /></label>
        <label>Mot de passe du site<input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="new-password" required /></label>
        <p className="request-note"><ShieldCheck size={13} />Enregistré dans le coffre local de Hermes, lié à ce site. Le bot ne voit jamais le mot de passe.</p>
        <div className="request-actions">
          <button type="button" onClick={() => answerValue('')}>Plus tard</button>
          <button type="submit" className="is-primary" disabled={!secret || !identifier}>Enregistrer et continuer</button>
        </div>
      </Sheet>
    )
  }

  if (method === 'vault.unlock_prompt') {
    const name = text(params.display_name) || text(params.backend) || 'le coffre'
    return (
      <Sheet title={`Déverrouiller ${name}`} onDecline={() => answerValue('')} onSubmit={submit(secret)}>
        <p>{botName} doit utiliser un identifiant enregistré dans {name}.</p>
        <label>Mot de passe principal<input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="new-password" required autoFocus /></label>
        <p className="request-note"><ShieldCheck size={13} />Valable pour cette session seulement. Le bot ne voit jamais ce mot de passe.</p>
        <div className="request-actions">
          <button type="button" onClick={() => answerValue('')}>Laisser verrouillé</button>
          <button type="submit" className="is-primary" disabled={!secret}>Déverrouiller</button>
        </div>
      </Sheet>
    )
  }

  const site = text(params.site)
  return (
    <Sheet title={`Code de vérification${site ? ` pour ${site}` : ''}`} onDecline={() => answerValue('')} onSubmit={submit(secret.trim())}>
      <p>{text(params.hint) || `${botName} attend le code reçu sur ton téléphone ou par mail.`}</p>
      <label>Code<input value={secret} onChange={(event) => setSecret(event.target.value)} inputMode="numeric" autoComplete="one-time-code" spellCheck={false} required autoFocus /></label>
      <div className="request-actions">
        <button type="button" onClick={() => answerValue('')}>Passer</button>
        <button type="submit" className="is-primary" disabled={!secret.trim()}>Valider</button>
      </div>
    </Sheet>
  )
}
