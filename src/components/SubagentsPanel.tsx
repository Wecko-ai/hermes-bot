import { useEffect, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Network } from 'lucide-react'
import type { SubagentTail } from '../lib/background'
import { formatDuration, isSubagentActive, subagentDuration, type SubagentRow } from '../lib/subagents'
import { toolLabel } from '../lib/work-summary'

/** What is kept of a transcript on screen: its end, where the child is now. */
const TAIL_CHARS = 4000

interface SubagentsPanelProps {
  rows: SubagentRow[]
  /** Background processes of the conversation still running. */
  processes: number
  onLoadTail: (subagentId: string) => Promise<SubagentTail>
}

type TailState = { state: 'loading' } | { state: 'failed' } | ({ state: 'ready' } & SubagentTail)

/**
 * Children delegated by the bot in this conversation: goal, status, duration, last tool, final summary, and the end
 * of the live transcript on click. Read only: nothing here steers or stops a child.
 */
export function SubagentsPanel({ rows, processes, onLoadTail }: SubagentsPanelProps) {
  const { t } = useTranslation()
  const running = rows.filter(isSubagentActive).length
  const finished = rows.length - running
  // Opens by itself once a child runs, and never closes by itself: the user may be reading a transcript.
  // The user's own choice wins after that.
  const [choice, setChoice] = useState<boolean | null>(null)
  const [sawRunning, setSawRunning] = useState(running > 0)
  useEffect(() => { if (running > 0) setSawRunning(true) }, [running])
  const open = choice ?? (running > 0 || sawRunning)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!open || running === 0) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [open, running])
  if (!rows.length) return null
  const ordered = [...rows].sort((a, b) => Number(isSubagentActive(b)) - Number(isSubagentActive(a)) || (b.startedAt ?? b.updatedAt) - (a.startedAt ?? a.updatedAt))
  return (
    <div className="subagents-dock">
      <section className={`subagents-panel ${open ? 'is-open' : ''}`} aria-label={t('subagents.title')}>
        <button className="subagents-head" aria-expanded={open} onClick={() => setChoice(!open)}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className="subagents-icon" aria-hidden="true"><Network size={13} /></span>
          <strong>{t('subagents.title')}</strong>
          <span className="subagents-counts">
            {running > 0 && <span className="is-running">{t('subagents.running', { count: running })}</span>}
            {finished > 0 && <span>{t('subagents.finished', { count: finished })}</span>}
            {processes > 0 && <span>{t('background.processes', { count: processes })}</span>}
          </span>
          <span className="subagents-readonly">{t('subagents.readOnly')}</span>
        </button>
        {open && (
          <ul className="subagents-list">
            {ordered.map((row) => <SubagentItem key={row.id} row={row} now={now} onLoadTail={onLoadTail} />)}
          </ul>
        )}
      </section>
    </div>
  )
}

function SubagentItem({ row, now, onLoadTail }: { row: SubagentRow; now: number; onLoadTail: SubagentsPanelProps['onLoadTail'] }) {
  const { t } = useTranslation()
  const [tail, setTail] = useState<TailState | null>(null)
  const duration = subagentDuration(row, now)
  const meta = [
    duration !== undefined ? formatDuration(duration) : '',
    row.lastTool ? t('subagents.lastTool', { tool: toolLabel(row.lastTool) }) : '',
    row.toolCount ? t('subagents.tools', { count: row.toolCount }) : '',
  ].filter(Boolean)
  const toggleTail = () => {
    if (tail) return setTail(null)
    setTail({ state: 'loading' })
    onLoadTail(row.id).then((result) => setTail({ state: 'ready', ...result })).catch(() => setTail({ state: 'failed' }))
  }
  return (
    <li className={`subagent-row is-${row.status}`} style={{ '--depth': Math.min(row.depth, 3) } as CSSProperties}>
      <button className="subagent-main" aria-expanded={tail !== null} title={t('subagents.showTail')} onClick={toggleTail}>
        <span className={`subagent-state is-${row.status}`}><span className="status-dot" aria-hidden="true" />{t(`subagents.status.${row.status}`)}</span>
        <span className="subagent-goal">{row.goal || t('subagents.noGoal')}</span>
        {meta.length > 0 && <span className="subagent-meta">{meta.join(' · ')}</span>}
      </button>
      {row.summary && <p className="subagent-summary">{row.summary}</p>}
      {tail && <SubagentTailView tail={tail} row={row} />}
    </li>
  )
}

function SubagentTailView({ tail, row }: { tail: TailState; row: SubagentRow }) {
  const { t } = useTranslation()
  if (tail.state === 'loading') return <p className="subagent-tail-note">{t('subagents.tailLoading')}</p>
  if (tail.state === 'ready' && tail.available && tail.text.trim()) {
    const cut = tail.truncated || tail.text.length > TAIL_CHARS
    return (
      <div className="subagent-tail">
        {cut && <p className="subagent-tail-note">{t('subagents.tailTruncated')}</p>}
        <pre>{tail.text.slice(-TAIL_CHARS)}</pre>
      </div>
    )
  }
  // The child has left the registry: the last tool results given with its end stand in for the transcript.
  if (row.outputTail?.length) {
    return (
      <div className="subagent-tail">
        <p className="subagent-tail-note">{t('subagents.outputTail')}</p>
        <pre>{row.outputTail.map((entry) => `${entry.isError ? '✗' : '✓'} ${toolLabel(entry.tool)}${entry.preview ? `\n${entry.preview}` : ''}`).join('\n\n')}</pre>
      </div>
    )
  }
  return <p className="subagent-tail-note">{t(tail.state === 'failed' ? 'subagents.tailFailed' : 'subagents.tailUnavailable')}</p>
}
