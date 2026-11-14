import { useEffect, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, Bot, Check, ChevronDown, ChevronRight, Code2, FileText, History, Network, ScrollText } from 'lucide-react'
import type { SubagentTail } from '../lib/background'
import { formatDuration, subagentDuration } from '../lib/subagents'
import { isEntryActive, plainPreview, promptPreview, subagentTitle, type SubagentEntry } from '../lib/subagent-history'
import { toolLabel } from '../lib/work-summary'
import { runLabel, parseAgentProgress } from '../lib/agent-process'
import { documentUrl, openableDocument, type MediaRef } from '../lib/media'

/** What is kept of a transcript on screen: its end, where the child is now. */
const TAIL_CHARS = 4000
/** A finished child stays this long in the chat, the time to see it end; the Subagents tab keeps it. */
export const FINISHED_LINGER_MS = 8_000

interface SubagentsPanelProps {
  entries: SubagentEntry[]
  profile: string
  /** Background processes of the conversation still running. */
  processes: number
  onLoadTail: (subagentId: string) => Promise<SubagentTail>
  /** Opens the Subagents tab of the details panel. */
  onOpenHistory?: () => void
  /** Opens a file in a tab beside the chat (a coding agent's prompt or log). */
  onOpenDocument?: (media: MediaRef) => void
}

export type TailState = { state: 'loading' } | { state: 'failed' } | ({ state: 'ready' } & SubagentTail)

/** Running, just finished, or opened by the user: a child being read never leaves under the pointer. */
const visibleInChat = (entry: SubagentEntry, now: number, opened: ReadonlySet<string>) =>
  isEntryActive(entry) || opened.has(entry.id) || ((entry.live !== undefined || entry.process !== undefined) && entry.finishedAt !== undefined && now - entry.finishedAt < FINISHED_LINGER_MS)

const basename = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path
const lastLine = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? ''

/** Reads the agent's own task journal through the local document route, never through a model or a remote URL. */
export function useAgentProgress(entry: SubagentEntry, profile: string): string[] {
  const statusFile = entry.run?.statusFile
  const active = isEntryActive(entry)
  const [progress, setProgress] = useState<string[]>([])
  useEffect(() => {
    setProgress([])
    if (!statusFile) return
    let cancelled = false
    let controller: AbortController | undefined
    const load = () => {
      controller?.abort()
      controller = new AbortController()
      fetch(documentUrl(profile, statusFile, Date.now()), { credentials: 'same-origin', signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) return ''
          return response.text()
        })
        .then((text) => { if (!cancelled && text) setProgress(parseAgentProgress(text)) })
        .catch(() => { /* Missing or changing journal: keep the last readable state. */ })
    }
    load()
    const timer = active ? window.setInterval(load, 5000) : undefined
    return () => {
      cancelled = true
      controller?.abort()
      if (timer !== undefined) window.clearInterval(timer)
    }
  }, [entry.id, profile, statusFile, active])
  return progress
}

const isCurrentProgress = (line: string) => /^\d+[.)]\s*\[(?:EN COURS|IN PROGRESS|BLOQUÉ|BLOCKED)/i.test(line)

/** Same visual language for a delegated Hermes child and a coding agent launched from a terminal. */
export function EntryType({ entry }: { entry: SubagentEntry }) {
  const { t } = useTranslation()
  const coding = Boolean(entry.run)
  const label = coding ? t('subagents.kindCode') : t('subagents.kindAgent')
  return (
    <span className={`subagent-type ${coding ? 'is-code' : 'is-agent'}`} title={entry.run?.tool ?? label}>
      {coding ? <Code2 size={12} aria-hidden="true" /> : <Bot size={12} aria-hidden="true" />}<span>{label}</span>
    </span>
  )
}

/** The essential live fact, whichever kind of child is running. */
export function EntryNow({ entry, progress = [] }: { entry: SubagentEntry; progress?: string[] }) {
  const { t } = useTranslation()
  if (!isEntryActive(entry)) return null
  const text = progress.at(-1)
    || (entry.live?.lastTool ? t('subagents.lastTool', { tool: toolLabel(entry.live.lastTool) }) : '')
    || (entry.process?.outputTail ? lastLine(entry.process.outputTail) : '')
  if (!text) return null
  return <span className="subagent-now subagent-live-box"><Activity size={12} aria-hidden="true" /><span>{text}</span></span>
}

/** A child's title: the first sentence of its prompt; for a coding agent without one, its tool and prompt file. */
export function entryTitle(t: (key: string) => string, entry: SubagentEntry) {
  if (entry.goal) return subagentTitle(entry.goal)
  return entry.run ? runLabel(entry.run) : t('subagents.noGoal')
}

/** Tool and folder of a coding agent, its exit code when it failed. */
export function runMeta(t: (key: string, options?: Record<string, unknown>) => string, entry: SubagentEntry) {
  if (!entry.run) return []
  return [
    entry.goal ? entry.run.tool : '',
    entry.run.cwd ? basename(entry.run.cwd) : '',
    entry.exitCode !== undefined && entry.exitCode !== 0 ? t('subagents.exitCode', { code: entry.exitCode }) : '',
  ].filter(Boolean)
}

/** Elapsed time of a running child, or the duration of a finished one. */
export function entryDuration(entry: SubagentEntry, now: number) {
  if (entry.durationSeconds !== undefined) return entry.durationSeconds
  if (entry.live) return subagentDuration(entry.live, now)
  if (entry.process && isEntryActive(entry) && entry.startedAt !== undefined) return Math.max(0, (now - entry.startedAt) / 1000)
  return undefined
}

/**
 * Children the bot is running in this conversation: who they are, what they were asked, where they are now.
 * A child leaves the chat a few seconds after it ends; the Subagents tab keeps them all. Read only: nothing
 * here steers or stops a child.
 */
export function SubagentsPanel({ entries, profile, processes, onLoadTail, onOpenHistory, onOpenDocument }: SubagentsPanelProps) {
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
            {shown.map((entry) => <SubagentItem key={entry.id} entry={entry} profile={profile} now={now} open={opened.has(entry.id)} onOpen={(open) => setOpen(entry.id, open)} onLoadTail={onLoadTail} onOpenDocument={onOpenDocument} />)}
          </ul>
        )}
      </section>
    </div>
  )
}

function SubagentItem({ entry, profile, now, open, onOpen, onLoadTail, onOpenDocument }: { entry: SubagentEntry; profile: string; now: number; open: boolean; onOpen: (open: boolean) => void; onLoadTail: SubagentsPanelProps['onLoadTail']; onOpenDocument?: (media: MediaRef) => void }) {
  const { t } = useTranslation()
  const [tail, setTail] = useState<TailState | null>(null)
  const progress = useAgentProgress(entry, profile)
  const duration = entryDuration(entry, now)
  const live = entry.live
  const active = isEntryActive(entry)
  const meta = [
    duration !== undefined ? formatDuration(duration) : '',
    ...runMeta(t, entry),
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
          <EntryType entry={entry} />
          {meta.length > 0 && <span className="subagent-meta">{meta.join(' · ')}</span>}
        </span>
        <span className="subagent-goal">{entryTitle(t, entry)}</span>
        {!open && !entry.run && promptPreview(entry.goal) && <span className="subagent-prompt-preview">{promptPreview(entry.goal)}</span>}
        <EntryNow entry={entry} progress={progress} />
        {!active && entry.result && <span className="subagent-result-preview">{plainPreview(entry.result, 180)}</span>}
      </button>
      {open && (
        <div className="subagent-details">
          <PromptView entry={entry} onOpenDocument={onOpenDocument} />
          <ProcessOutput entry={entry} progress={progress} onOpenDocument={onOpenDocument} />
          {tail && <SubagentTailView tail={tail} entry={entry} />}
        </div>
      )}
    </li>
  )
}

export function statusText(t: (key: string) => string, entry: SubagentEntry) {
  return entry.truncated && entry.status === 'completed' ? t('subagents.incomplete') : t(`subagents.status.${entry.status}`)
}

/** A file of a coding agent, opened in a tab beside the chat when the app can show it. */
function FileButton({ path, label, icon, onOpenDocument }: { path: string; label: string; icon: 'prompt' | 'log'; onOpenDocument?: (media: MediaRef) => void }) {
  const name = basename(path)
  if (!onOpenDocument || !openableDocument(path)) return <p className="subagent-file" title={path}>{label} : <code>{name}</code></p>
  return (
    <button className="subagent-file-button" title={path} onClick={() => onOpenDocument({ path, name, kind: 'document' })}>
      {icon === 'prompt' ? <FileText size={13} /> : <ScrollText size={13} />}<span>{label}</span><code>{name}</code>
    </button>
  )
}

/** The whole prompt: the goal, then the background the bot gave (known once the history has the call). */
export function PromptView({ entry, onOpenDocument }: { entry: SubagentEntry; onOpenDocument?: (media: MediaRef) => void }) {
  const { t } = useTranslation()
  const promptFile = entry.run?.promptFile
  return (
    <div className="subagent-prompt">
      <h4>{t('subagents.prompt')}</h4>
      {entry.goal && <p>{entry.goal}</p>}
      {promptFile && <FileButton path={promptFile} label={t('subagents.openPrompt')} icon="prompt" onOpenDocument={onOpenDocument} />}
      {!entry.goal && !promptFile && <p>{t(entry.run ? 'subagents.promptUnknown' : 'subagents.noGoal')}</p>}
      {entry.context && <><h4>{t('subagents.context')}</h4><p>{entry.context}</p></>}
    </div>
  )
}

/** A coding agent's progress and output: its task journal, what it prints, and the files it writes. */
export function ProcessOutput({ entry, progress = [], onOpenDocument }: { entry: SubagentEntry; progress?: string[]; onOpenDocument?: (media: MediaRef) => void }) {
  const { t } = useTranslation()
  if (!entry.run) return null
  const tail = isEntryActive(entry) ? entry.process?.outputTail : undefined
  if (!tail && !entry.run.logFile && !progress.length) return null
  return (
    <div className="subagent-tail">
      {progress.length > 0 && (
        <div className="agent-progress">
          <h4>{t('subagents.progress')}</h4>
          {progress.map((line, index) => {
            const current = isCurrentProgress(line)
            return <p key={`${index}-${line}`} className={current ? 'is-current' : ''}><span className="agent-progress-icon" aria-hidden="true">{current ? <Activity size={13} /> : <Check size={13} />}</span><span>{line}</span></p>
          })}
          {entry.run.statusFile && <FileButton path={entry.run.statusFile} label={t('subagents.openProgress')} icon="log" onOpenDocument={onOpenDocument} />}
        </div>
      )}
      {(tail || entry.run.logFile) && <h4>{t('subagents.output')}</h4>}
      {tail && <pre>{tail.slice(-TAIL_CHARS)}</pre>}
      {entry.run.logFile && <FileButton path={entry.run.logFile} label={t('subagents.openLog')} icon="log" onOpenDocument={onOpenDocument} />}
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
