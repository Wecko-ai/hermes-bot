import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import type { TeamExchange } from '../lib/team-feed'
import { shortTime } from '../lib/time'

interface TeamViewProps {
  items: TeamExchange[]
  onClose: () => void
  onOpenBot: (slug: string) => void
}

export function TeamView({ items, onClose, onOpenBot }: TeamViewProps) {
  const { t } = useTranslation()
  return (
    <div className="team-view" role="dialog" aria-label={t('team.title')}>
      <header className="team-view-header">
        <h2>{t('team.title')}</h2>
        <button type="button" className="round-icon-button" aria-label={t('details.close')} onClick={onClose}><X size={16} /></button>
      </header>
      {items.length === 0 && <p className="details-empty">{t('team.empty')}</p>}
      <ul className="team-view-list">
        {items.map((item) => (
          <li key={item.id}>
            <div className="team-view-meta">
              <button type="button" className="mention-chip" onClick={() => onOpenBot(item.from)}>{item.fromName || item.from}</button>
              <span>→</span>
              <button type="button" className="mention-chip" onClick={() => onOpenBot(item.to)}>{item.to}</button>
              <time>{shortTime(item.at)}</time>
            </div>
            <p>{item.text}</p>
          </li>
        ))}
      </ul>
    </div>
  )
}