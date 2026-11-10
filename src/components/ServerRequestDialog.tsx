import { useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { KeyRound, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { i18n } from '../i18n'
import type { ServerRequest } from '../lib/hermes'

const text = (value: unknown) => (typeof value === 'string' ? value : '')
// Getters: the label follows the interface language each time it is read.
export const CHOICE_LABELS: Record<string, string> = {
  get once() { return i18n.t('serverRequest.choices.once') },
  get session() { return i18n.t('serverRequest.choices.session') },
  get always() { return i18n.t('serverRequest.choices.always') },
  get deny() { return i18n.t('serverRequest.choices.deny') },
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
 * Requests the gateway addresses to the user during a turn: credentials vault and approvals.
 * The password only lives in this component’s state, unmounted as soon as it is answered.
 */
export function ServerRequestDialog({ request, botName, onAnswer }: ServerRequestDialogProps) {
  const { t } = useTranslation()
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
      <Sheet title={t('serverRequest.approvalTitle', { bot: botName })} onDecline={() => onAnswer(id, { choice: 'deny' })}>
        <p>{text(params.description) || t('serverRequest.approvalDefault')}</p>
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
      <Sheet title={t('serverRequest.credentialsTitle', { bot: botName })} onDecline={() => answerValue('')} onSubmit={submit(JSON.stringify({ identifier, password: secret }))}>
        <p>{t('serverRequest.checkSite')}</p>
        <p className="request-origin">{origin || text(params.site)}</p>
        <label>{t('serverRequest.siteIdentifier')}<input value={identifier} onChange={(event) => setIdentifier(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} required autoFocus /></label>
        <label>{t('serverRequest.sitePassword')}<input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="new-password" required /></label>
        <p className="request-note"><ShieldCheck size={13} />{t('serverRequest.credentialsNote')}</p>
        <div className="request-actions">
          <button type="button" onClick={() => answerValue('')}>{t('serverRequest.later')}</button>
          <button type="submit" className="is-primary" disabled={!secret || !identifier}>{t('serverRequest.saveAndContinue')}</button>
        </div>
      </Sheet>
    )
  }

  if (method === 'vault.unlock_prompt') {
    const name = text(params.display_name) || text(params.backend) || t('serverRequest.defaultVault')
    return (
      <Sheet title={t('serverRequest.unlockTitle', { name })} onDecline={() => answerValue('')} onSubmit={submit(secret)}>
        <p>{t('serverRequest.unlockBody', { bot: botName, name })}</p>
        <label>{t('serverRequest.masterPassword')}<input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="new-password" required autoFocus /></label>
        <p className="request-note"><ShieldCheck size={13} />{t('serverRequest.unlockNote')}</p>
        <div className="request-actions">
          <button type="button" onClick={() => answerValue('')}>{t('serverRequest.keepLocked')}</button>
          <button type="submit" className="is-primary" disabled={!secret}>{t('serverRequest.unlock')}</button>
        </div>
      </Sheet>
    )
  }

  const site = text(params.site)
  return (
    <Sheet title={site ? t('serverRequest.codeTitleFor', { site }) : t('serverRequest.codeTitle')} onDecline={() => answerValue('')} onSubmit={submit(secret.trim())}>
      <p>{text(params.hint) || t('serverRequest.codeHint', { bot: botName })}</p>
      <label>{t('serverRequest.code')}<input value={secret} onChange={(event) => setSecret(event.target.value)} inputMode="numeric" autoComplete="one-time-code" spellCheck={false} required autoFocus /></label>
      <div className="request-actions">
        <button type="button" onClick={() => answerValue('')}>{t('serverRequest.skip')}</button>
        <button type="submit" className="is-primary" disabled={!secret.trim()}>{t('serverRequest.submit')}</button>
      </div>
    </Sheet>
  )
}
