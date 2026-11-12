import { useEffect, useState } from 'react'
import { ArrowRight, LockKeyhole } from 'lucide-react'
import { useTranslation } from 'react-i18next'

// Black and white mark: a round face with a Hermes wing, traced from the app icon.
export function Logo() {
  return (
    <svg className="logo-mark" viewBox="111 91 760 760" aria-hidden="true">
      <g transform="translate(0 1024) scale(0.1 -0.1)">
        <path fill="#fff" d="M1480 9133 c-6 -27 -14 -129 -17 -228 -5 -155 -2 -197 16 -304 58 -339 243 -677 498 -911 36 -33 63 -63 60 -67 -9 -9 -246 111 -390 197 -66 39 -121 69 -124 66 -8 -8 106 -236 166 -332 28 -45 87 -133 132 -195 l81 -114 -11 -80 c-8 -57 -11 -654 -11 -2055 0 -2151 -2 -2057 56 -2248 107 -353 350 -650 671 -819 111 -58 259 -112 383 -139 81 -18 173 -19 2130 -19 1955 0 2049 1 2130 19 219 48 387 122 551 245 264 199 441 464 526 790 l28 106 0 2055 c0 1695 -2 2068 -14 2130 -30 164 -120 387 -211 520 -223 326 -591 553 -971 600 -69 8 -634 10 -2089 8 -1863 -3 -2000 -4 -2075 -21 -172 -38 -327 -97 -437 -168 -30 -19 -54 -28 -66 -25 -28 9 -240 163 -353 257 -131 107 -290 275 -393 411 -85 114 -236 343 -236 359 0 5 -4 9 -9 9 -5 0 -14 -21 -21 -47z" />
        <path fill="#000" d="M1481 9118 c-19 -104 -25 -313 -12 -428 43 -365 204 -689 480 -967 50 -50 91 -96 91 -102 0 -20 -256 111 -482 248 l-38 23 16 -39 c60 -143 167 -325 293 -501 l79 -109 -11 -44 c-15 -63 -22 -3934 -7 -4081 32 -319 160 -592 384 -821 165 -169 343 -278 573 -350 206 -65 85 -62 2288 -62 l2010 0 107 23 c272 57 474 163 672 352 244 233 385 507 426 830 8 59 10 687 7 2075 -3 1816 -5 1997 -20 2072 -56 273 -172 496 -357 687 -207 214 -435 343 -725 409 -89 20 -114 21 -2040 25 -1411 2 -1984 0 -2074 -8 -218 -20 -435 -90 -593 -191 l-47 -30 -58 39 c-395 270 -631 511 -869 890 -37 59 -71 111 -75 115 -3 5 -12 -20 -18 -55z m203 -452 c121 -155 317 -344 503 -484 470 -355 1059 -603 1938 -817 267 -65 320 -82 455 -151 340 -172 538 -482 557 -867 3 -65 9 -114 13 -110 5 4 18 49 31 98 29 111 32 300 6 379 l-16 48 46 -7 c128 -19 284 -89 390 -175 84 -68 154 -157 209 -265 38 -75 44 -83 38 -50 -33 190 -144 374 -291 483 -119 88 -307 162 -413 162 -33 0 -41 5 -64 41 -15 22 -26 42 -24 45 16 15 183 29 358 28 225 0 321 -12 518 -64 581 -155 966 -544 1225 -1240 20 -52 39 -103 42 -112 5 -12 -28 -1 -122 41 -176 80 -479 192 -653 241 -776 219 -1470 195 -2272 -79 -81 -28 -175 -62 -209 -76 -34 -14 -66 -25 -70 -25 -12 0 18 67 57 127 18 29 65 84 103 123 l69 71 -92 -8 c-442 -38 -764 46 -1144 298 -67 44 -122 82 -122 83 0 2 35 -7 78 -20 289 -89 658 -129 977 -105 185 14 276 23 272 27 -1 2 -90 21 -197 44 -709 149 -1104 311 -1487 608 -193 151 -408 383 -512 555 l-24 38 124 -62 c366 -183 671 -296 1199 -442 317 -88 791 -209 797 -204 2 3 -20 13 -49 22 -95 31 -639 235 -818 307 -730 294 -1144 614 -1365 1056 -77 156 -145 398 -145 521 l0 36 19 -30 c10 -16 39 -57 65 -89z m5085 -1931 c89 -30 182 -66 206 -80 57 -33 110 -96 129 -153 23 -65 20 -312 -3 -312 -3 0 -25 33 -49 73 -104 175 -248 351 -383 467 -38 33 -68 60 -66 60 1 0 76 -25 166 -55z m-1123 -835 c372 -29 722 -110 1099 -252 71 -27 160 -63 196 -79 l67 -31 50 -116 c195 -452 218 -893 71 -1337 -185 -558 -631 -1008 -1176 -1185 -688 -224 -1442 0 -1918 571 -287 343 -435 750 -435 1194 0 285 58 542 173 775 l52 105 135 53 c616 243 1171 342 1686 302z M3003 6867 c35 -29 272 -130 417 -178 80 -26 222 -64 315 -84 310 -67 383 -92 509 -178 l60 -40 -33 41 c-62 79 -189 176 -260 201 -19 6 -134 30 -255 52 -255 46 -488 103 -631 153 -152 53 -143 50 -122 33z M5415 5213 c-65 -34 -110 -94 -289 -392 -80 -133 -86 -147 -86 -198 0 -56 19 -114 48 -147 26 -30 113 -66 157 -66 53 0 114 29 149 71 16 19 90 131 165 249 l136 215 0 82 c0 76 -2 84 -31 120 -59 75 -175 106 -249 66z M6514 4974 c-53 -26 -88 -72 -228 -297 -140 -227 -156 -266 -141 -339 20 -96 88 -157 183 -165 49 -5 69 -2 105 16 56 27 65 40 210 273 129 209 152 249 161 294 17 76 -41 180 -118 215 -50 23 -130 24 -172 3z" />
      </g>
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
