import { useEffect, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, History, Network } from 'lucide-react'
import type { SubagentTail } from '../lib/background'
import { formatDuration, subagentDuration } from '../lib/subagents'
import { isEntryActive, plainPreview, promptPreview, subagentTitle, type SubagentEntry } from '../lib/subagent-history'
import { toolLabel } from '../lib/work-summary'

/** What is kept of a transcript on screen: its end, where the child is now. */
const TAIL_CHARS = 4000
/** A finished child stays this long in the chat, the time to see it end; the Subagents tab keeps it. */
export const FINISHED_LINGER_MS = 8_000

interface SubagentsPanelProps {
  entries: SubagentEntry[]
  /** Background processes of the conversation still running. */
  processes: number
  onLoadTail: (subagentId: string) => Promise<SubagentTail>
  /** Opens the Subagents tab of the details panel. */
  onOpenHistory?: () => void
}

export type TailState = { state: 'loading' } | { state: 'failed' } | ({ state: 'ready' } & SubagentTail)

/** Running, just finished, or opened by the user: a child being read never leaves under the pointer. */
const visibleInChat = (entry: SubagentEntry, now: number, opened: ReadonlySet<string>) =>
  isEntryActive(entry) || opened.has(entry.id) || (entry.live !== undefined && entry.finishedAt !== undefined && now - entry.finishedAt < FINISHED_LINGER_MS)

/** Elapsed time of a running child, or the duration of a finished one. */
export function entryDuration(entry: SubagentEntry, now: number) {
  if (entry.durationSeconds !== undefined) return entry.durationSeconds
  if (entry.live) return subagentDuration(entry.live, now)
  return undefined
}

/**
 * Children the bot is running in this conversation: who they are, what they were asked, where they are now.
 * A child leaves the chat a few seconds after it ends; the Subagents tab keeps them all. Read only: nothing
 * here steers or stops a child.
 */
export function SubagentsPanel({ entries, processes, onLoadTail, onOpenHistory }: SubagentsPanelProps) {
  const { t } = useTranslation()
  const [now, setNow] = useState(() => Date.now())
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set())
  const shown = entries.filter((entry) => visibleInChat(entry, now, opened))
  const setOpen = (id: string, open: boolean) => {
    setOpened((current) => {
      const next = new Set(current)
      if (open) next.add(id)
      else next.delete(id)
      return next
    })
    setNow(Date.now())
  }
  const running = shown.filter(isEntryActive).length
  const finished = shown.length - running
  // Ticks while something runs (durations), and once more when the last finished child is due to leave.
  useEffect(() => {
    if (running > 0) {
      const timer = setInterval(() => setNow(Date.now()), 1000)
      return () => clearInterval(timer)
    }
    const leaving = entries
      .filter((entry) => entry.live && entry.finishedAt !== undefined && !isEntryActive(entry))
      .map((entry) => entry.finishedAt! + FINISHED_LINGER_MS - Date.now())
      .filter((wait) => wait > 0)
    if (!leaving.length) return
    const timer = setTimeout(() => setNow(Date.now()), Math.min(...leaving) + 50)
    return () => clearTimeout(timer)
  }, [entries, running])
  const [collapsed, setCollapsed] = useState(false)
  if (!shown.length) return null
  return (
    <div className="subagents-dock">
      <section className={`subagents-panel ${collapsed ? '' : 'is-open'}`} aria-label={t('subagents.title')}>
        <div className="subagents-head">
          <button className="subagents-toggle" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
            {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            <span className="subagents-icon" aria-hidden="true"><Network size={13} /></span>
            <strong>{t('subagents.title')}</strong>
            <span className="subagents-counts">
              {running > 0 && <span className="is-running">{t('subagents.running', { count: running })}</span>}
              {finished > 0 && <span>{t('subagents.finished', { count: finished })}</span>}
              {processes > 0 && <span>{t('background.processes', { count: processes })}</span>}
            </span>
          </button>
          {onOpenHistory && (
            <button className="subagents-history" title={t('subagents.openHistory')} onClick={onOpenHistory}>
              <History size={13} /><span>{t('subagents.history')}</span>
            </button>
          )}
        </div>
        {!collapsed && (
          <ul className="subagents-list">
            {shown.map((entry) => <SubagentItem key={entry.id} entry={entry} now={now} open={opened.has(entry.id)} onOpen={(open) => setOpen(entry.id, open)} onLoadTail={onLoadTail} />)}
          </ul>
        )}
      </section>
    </div>
  )
}

function SubagentItem({ entry, now, open, onOpen, onLoadTail }: { entry: SubagentEntry; now: number; open: boolean; onOpen: (open: boolean) => void; onLoadTail: SubagentsPanelProps['onLoadTail'] }) {
  const { t } = useTranslation()
  const [tail, setTail] = useState<TailState | null>(null)
  const duration = entryDuration(entry, now)
  const live = entry.live
  const active = isEntryActive(entry)
  const meta = [
    duration !== undefined ? formatDuration(duration) : '',
    live?.toolCount ? t('subagents.tools', { count: live.toolCount }) : '',
    entry.taskCount > 1 ? t('subagents.task', { index: entry.taskIndex + 1, count: entry.taskCount }) : '',
  ].filter(Boolean)
  const toggle = () => {
    const next = !open
    onOpen(next)
    if (!next || !live || tail) return
    setTail({ state: 'loading' })
    onLoadTail(live.id).then((result) => setTail({ state: 'ready', ...result })).catch(() => setTail({ state: 'failed' }))
  }
  return (
    <li className={`subagent-row is-${entry.status}`} style={{ '--depth': Math.min(live?.depth ?? 0, 3) } as CSSProperties}>
      <button className="subagent-main" aria-expanded={open} title={t('subagents.showDetails')} onClick={toggle}>
        <span className="subagent-line">
          <span className={`subagent-state is-${entry.status}`}><span className="status-dot" aria-hidden="true" />{statusText(t, entry)}</span>
          {meta.length > 0 && <span className="subagent-meta">{meta.join(' · ')}</span>}
        </span>
        <span className="subagent-goal">{entry.goal ? subagentTitle(entry.goal) : t('subagents.noGoal')}</span>
        {!open && promptPreview(entry.goal) && <span className="subagent-prompt-preview">{promptPreview(entry.goal)}</span>}
        {active && live?.lastTool && <span className="subagent-now">{t('subagents.lastTool', { tool: toolLabel(live.lastTool) })}</span>}
        {!active && entry.result && <span className="subagent-result-preview">{plainPreview(entry.result, 180)}</span>}
      </button>
      {open && (
        <div className="subagent-details">
          <PromptView entry={entry} />
          {tail && <SubagentTailView tail={tail} entry={entry} />}
        </div>
      )}
    </li>
  )
}

export function statusText(t: (key: string) => string, entry: SubagentEntry) {
  return entry.truncated && entry.status === 'completed' ? t('subagents.incomplete') : t(`subagents.status.${entry.status}`)
}

/** The whole prompt: the goal, then the background the bot gave (known once the history has the call). */
export function PromptView({ entry }: { entry: SubagentEntry }) {
  const { t } = useTranslation()
  return (
    <div className="subagent-prompt">
      <h4>{t('subagents.prompt')}</h4>
      <p>{entry.goal || t('subagents.noGoal')}</p>
      {entry.context && <><h4>{t('subagents.context')}</h4><p>{entry.context}</p></>}
    </div>
  )
}

export function SubagentTailView({ tail, entry }: { tail: TailState; entry: SubagentEntry }) {
  const { t } = useTranslation()
  if (tail.state === 'loading') return <p className="subagent-tail-note">{t('subagents.tailLoading')}</p>
  if (tail.state === 'ready' && tail.available && tail.text.trim()) {
    const cut = tail.truncated || tail.text.length > TAIL_CHARS
    return (
      <div className="subagent-tail">
        <h4>{t('subagents.liveTail')}</h4>
        {cut && <p className="subagent-tail-note">{t('subagents.tailTruncated')}</p>}
        <pre>{tail.text.slice(-TAIL_CHARS)}</pre>
      </div>
    )
  }
  // The child has left the registry: the last tool results given with its end stand in for the transcript.
  const outputTail = entry.live?.outputTail
  if (outputTail?.length) {
    return (
      <div className="subagent-tail">
        <h4>{t('subagents.outputTail')}</h4>
        <pre>{outputTail.map((item) => `${item.isError ? '✗' : '✓'} ${toolLabel(item.tool)}${item.preview ? `\n${item.preview}` : ''}`).join('\n\n')}</pre>
      </div>
    )
  }
  return <p className="subagent-tail-note">{t(tail.state === 'failed' ? 'subagents.tailFailed' : 'subagents.tailUnavailable')}</p>
}
