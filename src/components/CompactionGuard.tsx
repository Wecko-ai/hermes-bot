import { useTranslation } from 'react-i18next'
import { AlertTriangle, Archive } from 'lucide-react'
import { compactNumber } from '../lib/model'
import type { Guard } from '../lib/compaction'

interface CompactionGuardProps {
  guard: Guard
  botName: string
  /** The bot is working: Hermes only compacts an idle session. */
  running: boolean
  compacting: boolean
  onCompact: () => void
  /** "Later" (warning only). */
  onLater: () => void
  onOpenSettings: () => void
}

/**
 * Manual compaction mode, above the field. Warning (90 % of the user's limit): a popover with Compact now or
 * Later. Limit reached (100 %): sending is blocked, this panel says why and how to go on.
 */
export function CompactionGuard({ guard, botName, running, compacting, onCompact, onLater, onOpenSettings }: CompactionGuardProps) {
  const { t } = useTranslation()
  const full = guard.level === 'full'
  const used = compactNumber(guard.used)
  const limit = compactNumber(guard.limit)
  const action = (
    <button type="button" className="compaction-guard-primary" disabled={running || compacting} onClick={onCompact}>
      {compacting ? t('compaction.compacting') : running ? t('compaction.afterTurn') : t('compaction.warnAction')}
    </button>
  )
  return (
    <div className={`compaction-guard ${full ? 'is-full' : 'is-warn'}`} role={full ? 'alert' : 'status'} data-guard={guard.level}>
      <span className="compaction-guard-icon" aria-hidden="true">{full ? <AlertTriangle size={16} /> : <Archive size={16} />}</span>
      <p>
        {full
          ? t('compaction.full', { used, limit })
          : t('compaction.warn', { name: botName, percent: guard.percent, used, limit })}
        {running && <span className="compaction-guard-note"> {t('compaction.busy', { name: botName })}</span>}
      </p>
      <div className="compaction-guard-actions">
        {action}
        {full
          ? <button type="button" onClick={onOpenSettings}>{t('compaction.settings')}</button>
          : <button type="button" disabled={compacting} onClick={onLater}>{t('compaction.later')}</button>}
      </div>
    </div>
  )
}
