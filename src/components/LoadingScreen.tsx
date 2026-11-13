import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Logo } from './Login'
import './LoadingScreen.css'

/** One heartbeat of the logo, in ms: `LoadingScreen.css` runs the same length. */
const BEAT_MS = 1_400

/**
 * The app's waiting screen: the logo beating like a heart, "Loading…" under it. `index.html` holds the same markup
 * while the code loads. Each screen picks up the beat where the page is, so the handover never skips a beat.
 */
export function LoadingScreen() {
  const { t } = useTranslation()
  const [phase] = useState(() => `-${Math.round(performance.now() % BEAT_MS)}ms`)
  return (
    <div className="app-loading" role="status" aria-live="polite">
      <span className="loading-heart" style={{ animationDelay: phase }} aria-hidden="true"><Logo /></span>
      <p>{t('loading.label')}</p>
    </div>
  )
}
