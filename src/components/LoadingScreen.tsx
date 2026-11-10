import { Logo } from './Login'

/** The app’s waiting screen. `index.html` holds the same shape while the code loads. */
export function LoadingScreen({ label }: { label: string }) {
  return (
    <div className="app-loading" role="status" aria-live="polite">
      <Logo />
      <p>{label}</p>
      <div className="loading-bar" aria-hidden="true"><i /></div>
    </div>
  )
}
