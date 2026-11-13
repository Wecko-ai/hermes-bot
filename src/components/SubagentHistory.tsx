import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Network } from 'lucide-react'
import type { SubagentTail } from '../lib/background'
import { formatDuration } from '../lib/subagents'
import { isEntryActive, plainPreview, promptPreview, subagentTitle, type SubagentEntry } from '../lib/subagent-history'
import { modelLabel } from '../lib/model'
import { dateTime, shortTime } from '../lib/time'
import { toolLabel } from '../lib/work-summary'
import type { MediaRef } from '../lib/media'
import { Markdown } from './MessageList'
import { entryDuration, PromptView, statusText, SubagentTailView, type TailState } from './SubagentsPanel'

interface SubagentHistoryProps {
  entries: SubagentEntry[]
  profile: string
  onLoadTail: (subagentId: string) => Promise<SubagentTail>
  onOpenImages: (images: MediaRef[], index: number, version: string) => void
  onOpenDocument: (media: MediaRef) => void
}

/**
 * Every child the bot delegated in this conversation, most recent first: status, prompt, result. Read from the
 * history (`delegate_task` calls and the gateway's completion messages) and this window's live rows. Read only.
 */
export function SubagentHistory({ entries, profile, onLoadTail, onOpenImages, onOpenDocument }: SubagentHistoryProps) {
  const { t } = useTranslation()
  const running = entries.filter(isEntryActive).length
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  return (
    <section className="details-section subagent-history">
      <div className="details-section-heading">
        <span>{t('subagents.historyHeading')}</span>
        <span className="details-count"><Network size={13} /> {running > 0 ? t('subagents.running', { count: running }) : entries.length}</span>
      </div>
      {entries.length === 0 && <p className="details-empty">{t('subagents.historyEmpty')}</p>}
      {entries.map((entry) => <SubagentCard key={entry.id} entry={entry} now={now} profile={profile} onLoadTail={onLoadTail} onOpenImages={onOpenImages} onOpenDocument={onOpenDocument} />)}
      {entries.length > 0 && <p className="readonly-note">{t('subagents.historyNote')}</p>}
    </section>
  )
}

function SubagentCard({ entry, now, profile, onLoadTail, onOpenImages, onOpenDocument }: { entry: SubagentEntry; now: number } & Omit<SubagentHistoryProps, 'entries'>) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [tail, setTail] = useState<TailState | null>(null)
  const duration = entryDuration(entry, now)
  const active = isEntryActive(entry)
  const live = entry.live
  const when = entry.startedAt ?? entry.finishedAt
  const meta = [
    entry.model ? modelLabel(entry.model) : '',
    live?.toolCount ? t('subagents.tools', { count: live.toolCount }) : entry.apiCalls ? t('subagents.apiCalls', { count: entry.apiCalls }) : '',
    entry.taskCount > 1 ? t('subagents.task', { index: entry.taskIndex + 1, count: entry.taskCount }) : '',
  ].filter(Boolean)
  const loadTail = () => {
    if (!live) return
    setTail({ state: 'loading' })
    onLoadTail(live.id).then((result) => setTail({ state: 'ready', ...result })).catch(() => setTail({ state: 'failed' }))
  }
  return (
    <article className={`subagent-card is-${entry.status} ${open ? 'is-open' : ''}`}>
      <button className="subagent-card-head" aria-expanded={open} title={t('subagents.showDetails')} onClick={() => setOpen(!open)}>
        <span className="subagent-line">
          <span className={`subagent-state is-${entry.status}`}><span className="status-dot" aria-hidden="true" />{statusText(t, entry)}</span>
          <span className="subagent-meta" title={when ? dateTime(new Date(when).toISOString()) : undefined}>
            {[when ? shortTime(new Date(when).toISOString()) : '', duration !== undefined ? formatDuration(duration) : ''].filter(Boolean).join(' · ')}
          </span>
        </span>
        <strong className="subagent-goal">{entry.goal ? subagentTitle(entry.goal) : t('subagents.noGoal')}</strong>
        {meta.length > 0 && <span className="subagent-meta">{meta.join(' · ')}</span>}
        {!open && promptPreview(entry.goal) && <span className="subagent-prompt-preview">{promptPreview(entry.goal)}</span>}
        {!open && active && live?.lastTool && <span className="subagent-now">{t('subagents.lastTool', { tool: toolLabel(live.lastTool) })}</span>}
        {!open && (entry.result || entry.error) && <span className="subagent-result-preview">{plainPreview(entry.result || entry.error || '', 220)}</span>}
      </button>
      {open && (
        <div className="subagent-details">
          <PromptView entry={entry} />
          {(entry.result || entry.error) && (
            <div className="subagent-result">
              <h4>{t('subagents.result')}</h4>
              {entry.error && <p className="subagent-error">{entry.error}</p>}
              {entry.result && <div className="message-content subagent-result-body"><Markdown content={entry.result} profile={profile} version={entry.id} onOpenImages={onOpenImages} onOpenDocument={onOpenDocument} /></div>}
            </div>
          )}
          {!entry.result && !entry.error && !active && <p className="subagent-tail-note">{t('subagents.noResult')}</p>}
          {live && !tail && <button className="subagent-tail-button" onClick={loadTail}>{t(active ? 'subagents.showLiveTail' : 'subagents.showOutputTail')}</button>}
          {tail && <SubagentTailView tail={tail} entry={entry} />}
        </div>
      )}
    </article>
  )
}
