import { useEffect, useState } from 'react'
import { ArrowRight, LockKeyhole } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function Logo() {
  return (
    <svg className="logo-mark" viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="15" fill="var(--accent)" />
      <path fill="#fff" d="M18 13h28a9 9 0 0 1 9 9v17a9 9 0 0 1-9 9H28l-11 9 2-9.1A9 9 0 0 1 9 39V22a9 9 0 0 1 9-9Z" />
      <path fill="var(--accent)" d="M23 21.5h5.5V28h7v-6.5H41v18h-5.5V33h-7v6.5H23Z" />
    </svg>
  )
}

// The gateway answered that it needs no password, but the server could not confirm it is this user's own.
const LOCAL_BLOCKED = new Set(['unsafe_home', 'gateway_not_running', 'gateway_elsewhere', 'no_token'])

export function Login({ onLogin, onLocalSignIn, error }: {
  onLogin: (username: string, password: string, remember: boolean) => Promise<void>
  onLocalSignIn: () => Promise<void>
  error: string
}) {
  const { t } = useTranslation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [remember, setRemember] = useState(true)
  // Only the desktop app has the Keychain: without it nothing is kept and the checkbox doesn’t appear.
  const [canRemember, setCanRemember] = useState(false)
  // A Hermes without a password has no use for the form: 'ready' (sign-in needs the local key) or the reason it is blocked.
  const [local, setLocal] = useState('')
  useEffect(() => {
    fetch('/api/auth/options', { credentials: 'same-origin' }).then((response) => response.json()).then((options) => {
      setCanRemember(options.remember === true)
      if (options.local?.available === true) setLocal('ready')
      else if (LOCAL_BLOCKED.has(options.local?.reason)) setLocal(String(options.local.reason))
    }).catch(() => { /* checkbox stays hidden */ })
  }, [])
  const retryLocal = async () => {
    setBusy(true)
    try { await onLocalSignIn() } finally { setBusy(false) }
  }
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try { await onLogin(username, password, canRemember && remember) } finally { setBusy(false) }
  }
  return (
    <main className="login-page">
      <section className="login-card">
        <Logo />
        <p className="login-eyebrow">HERMESBOT</p>
        <h1>{t('login.title')}</h1>
        <p className="login-intro">{t('login.intro')}</p>
        {local && (
          <div className="login-local">
            <p className="login-intro">{local === 'ready' ? t('login.localHelp') : t('login.localBlocked', { reason: local })}</p>
            {error && <p className="login-error" role="alert">{error}</p>}
            <button className="login-submit" type="button" disabled={busy} onClick={retryLocal}>{busy ? t('login.signingIn') : t('login.localRetry')}{!busy && <ArrowRight size={17} />}</button>
          </div>
        )}
        {!local && <form onSubmit={submit}>
          <label>{t('login.username')}<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required autoFocus /></label>
          <label>{t('login.password')}<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label>
          {canRemember && <label className="login-remember"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />{t('login.remember')}</label>}
          {error && <p className="login-error" role="alert">{error}</p>}
          <button className="login-submit" type="submit" disabled={busy}>{busy ? t('login.signingIn') : t('login.submit')}{!busy && <ArrowRight size={17} />}</button>
        </form>}
        <p className="login-security"><LockKeyhole size={13} />{local ? t('login.localSecurity') : t('login.security')}{!local && canRemember && remember && ` ${t('login.securityKeychain')}`}</p>
      </section>
    </main>
  )
}
