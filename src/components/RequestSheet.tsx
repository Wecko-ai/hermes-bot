import { useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { KeyRound, Minus } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/** What a vault sheet asks for: drives the reminder line and the minimized pill. */
export type RequestAsk = 'login' | 'master' | 'code' | 'signup'

/** Host of an origin for the pill (`https://a.b/` gives `a.b`), the raw text otherwise. */
export const siteLabel = (site: string) => {
  try { return new URL(site).host || site } catch { return site }
}

interface DockedRequestSheetProps {
  title: string
  /** Accessible name of the sheet, the title otherwise. */
  label?: string
  botName: string
  /** Origin or site name the request is about, when the requester gives one. */
  site?: string
  ask: RequestAsk
  /** Interpolated into the reminder line (`name` of the vault to unlock). */
  askValues?: Record<string, string>
  /** Plain-text excerpt of the bot's latest finished reply. */
  context?: string
  /** Shown right under the title (the site offers "Continue with Google"…). */
  banner?: ReactNode
  className?: string
  scrimClassName?: string
  onDecline: () => void
  onSubmit: (event: FormEvent) => void
  children: ReactNode
}

/**
 * Vault requests: a sheet docked at the bottom right, without a backdrop, so the conversation behind
 * stays readable, scrollable and clickable. Minimizing only hides the body: what was typed stays.
 */
export function DockedRequestSheet({ title, label, botName, site, ask, askValues, context, banner, className = '', scrimClassName = '', onDecline, onSubmit, children }: DockedRequestSheetProps) {
  const { t } = useTranslation()
  const [minimized, setMinimized] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') onDecline()
  }
  const restore = () => {
    setMinimized(false)
    // Back to the field the user was filling in.
    requestAnimationFrame(() => bodyRef.current?.querySelector<HTMLInputElement>('input:not([disabled])')?.focus())
  }
  const what = t(`vaultSheet.short.${ask}`)
  const pill = site ? t('vaultSheet.pill', { bot: botName, what, site: siteLabel(site) }) : t('vaultSheet.pillNoSite', { bot: botName, what })

  return (
    <div className={`request-scrim is-docked ${scrimClassName}`.trim()} role="presentation" onKeyDown={onKeyDown}>
      <form className={`request-sheet is-docked ${minimized ? 'is-minimized' : ''} ${className}`.replace(/\s+/g, ' ').trim()} role="dialog" aria-modal="false" aria-label={label || title} autoComplete="off" onSubmit={onSubmit}>
        {minimized && (
          <button type="button" className="request-pill" onClick={restore} title={t('vaultSheet.restore')}>
            <KeyRound size={14} aria-hidden="true" /><span>{pill}</span>
          </button>
        )}
        <div className="request-body" ref={bodyRef} hidden={minimized}>
          <div className="request-head">
            <div className="request-icon" aria-hidden="true"><KeyRound size={18} /></div>
            <button type="button" className="request-minimize" onClick={() => setMinimized(true)}><Minus size={14} aria-hidden="true" />{t('vaultSheet.minimize')}</button>
          </div>
          <h2>{title}</h2>
          {banner}
          <dl className="request-context">
            <div><dt>{t('vaultSheet.bot')}</dt><dd>{botName}</dd></div>
            {site && <div><dt>{t('vaultSheet.site')}</dt><dd className="request-origin">{site}</dd></div>}
            <div><dt>{t('vaultSheet.asked')}</dt><dd>{t(`vaultSheet.ask.${ask}`, askValues)}</dd></div>
          </dl>
          {context && (
            <figure className="request-excerpt">
              <figcaption>{t('vaultSheet.lastMessage')}</figcaption>
              <blockquote>{context}</blockquote>
            </figure>
          )}
          {children}
        </div>
      </form>
    </div>
  )
}
