import { Logo } from './Login'

/** Écran d’attente de l’app. `index.html` en contient la même forme, pour le temps de charger le code. */
export function LoadingScreen({ label }: { label: string }) {
  return (
    <div className="app-loading" role="status" aria-live="polite">
      <Logo />
      <p>{label}</p>
      <div className="loading-bar" aria-hidden="true"><i /></div>
    </div>
  )
}
