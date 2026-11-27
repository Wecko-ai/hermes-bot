import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { nextRovingIndex } from '../lib/a11y-focus'
import { Activity, ChevronDown, Clock3, FileText, Images, Info, Monitor, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Bot, ChatMessage, Routine, SessionUsage } from '../types'
import type { HermesClient } from '../lib/hermes'
import { deleteRoutine, pauseRoutine, resumeRoutine, triggerRoutine } from '../lib/routines'
import { RoutineEditorDialog } from './RoutineEditorDialog'
import { ConnectorsTab } from './ConnectorsTab'
import { statusLabel } from './BotAvatar'
import { LiveAvatar, avatarPhase } from './LiveAvatar'
import { DocumentView, type OpenDocument } from './DocumentView'
import { MediaViewer, type ViewerState } from './MediaEmbed'
import { MediaGallery } from './MediaGallery'
import { UsageTab, type UsageDetails } from './UsageTab'
import { PagesLibraryPanel } from './PagesLibraryPanel'
import { useAppConfig } from '../lib/app-config'
import type { LibraryPage } from '../lib/pages-library'
import { dateTime, relativeTime, shortTime } from '../lib/time'
import { conversationMedia, type MediaRef } from '../lib/media'
import { workLine, type WorkSummary } from '../lib/work-summary'
import { stepIds } from '../lib/turns'
import { backgroundSummary, effectiveStatus, type SubagentTail } from '../lib/background'
import { isEntryActive, type SubagentEntry } from '../lib/subagent-history'
import { SubagentHistory } from './SubagentHistory'
import { ComputerPanel } from './ComputerPanel'
import { ViewEmpty } from './ViewEmpty'
import { chipModelLabel, formatUsage } from '../lib/model'
import type { LiveRuntime } from '../lib/runtime-state'
import type { CompactionMode, Guard } from '../lib/compaction'

function cleanRoutineName(name: string, bot: Bot) {
  const strip = (value: string, prefix: string) =>
    value.toLowerCase().startsWith(prefix.toLowerCase()) ? value.slice(prefix.length).trimStart() : value
  return strip(strip(name, `[bot:${bot.slug}]`), `${bot.name}:`)
}

type Tab = 'routines' | 'connectors' | 'activity' | 'subagents' | 'media' | 'computer' | 'usage' | 'library' | 'about'

/** A tab asked for from outside (the Subagents block's History); `at` makes each request new. */
export interface DetailsTabRequest {
  tab: Tab
  at: number
}

export const BOT_RAIL_TAB = 'bot'

interface DetailsPanelProps {
  bot: Bot
  work?: WorkSummary
  routines: Routine[]
  messages: ChatMessage[]
  /** Children delegated in this conversation, most recent first. */
  subagents: SubagentEntry[]
  onLoadSubagentTail: (subagentId: string) => Promise<SubagentTail>
  tabRequest: DetailsTabRequest | null
  loading: boolean
  running: boolean
  /** Open chat session. A new session with the same bot reloads usage. */
  sessionId?: string
  usage: SessionUsage | null
  /** Live context readout for the open chat (omits stale context right after a model switch). */
  contextUsage?: (SessionUsage & { scope?: 'worker' | 'turn' }) | null
  liveRuntime?: LiveRuntime | null
  /** Effective model of the session, for the Usage tab (avoids a false positive when the chat changed models vs bot.model). */
  sessionModel?: string
  modelLabel?: string
  modelPickerOpen?: boolean
  onOpenModels?: (query: string) => void
  /** Per-chat Delegate switch: the chat's model plans and reviews; the local worker does the work. */
  delegate?: {
    on: boolean
    available: boolean
    busy: boolean
    chef: string
    worker: string
    error?: string
    reason?: string
    turnIsLocal?: boolean
    workerUp?: boolean | null
    workerError?: string
    workerDownFallback?: boolean
    onToggle: (on: boolean) => void
  }
  compaction?: {
    mode: CompactionMode
    gauge: number
    guard: Guard
    compacting: boolean
    onCompact: () => void
    onOpenSettings: () => void
    tooltip: string
  }
  loadUsageDetails: () => Promise<UsageDetails>
  onOpenDocument: (profile: string, media: MediaRef) => void
  documents: OpenDocument[]
  railTab: string
  onSelectRailTab: (tab: string) => void
  onCloseDocument: (id: string) => void
  onReloadDocument: (id: string) => void
  onClose: () => void
  client: HermesClient | null
  routinesEditable: boolean
  connectorsEnabled: boolean
  onReloadRoutines: () => void
  computerPanelEnabled?: boolean
  onComputerSteer?: (text: string) => Promise<void>
  onOpenLibraryPage?: (page: LibraryPage) => void
}

export function DetailsPanel({ bot, work, routines, messages, subagents, onLoadSubagentTail, tabRequest, loading, running, sessionId, usage, contextUsage, liveRuntime, sessionModel, modelLabel, modelPickerOpen, onOpenModels, delegate, compaction, loadUsageDetails, onOpenDocument, documents, railTab, onSelectRailTab, onCloseDocument, onReloadDocument, onClose, client, routinesEditable, connectorsEnabled, onReloadRoutines, computerPanelEnabled, onComputerSteer, onOpenLibraryPage }: DetailsPanelProps) {
  const { t } = useTranslation()
  const shownContext = contextUsage !== undefined ? contextUsage : usage
  const contextScope = (shownContext && 'scope' in shownContext) ? shownContext.scope : undefined
  const usageText = contextScope === 'worker' ? t('details.session.liveWorkerContext', { readout: formatUsage(shownContext) }) : formatUsage(shownContext)
  const delegateLocalOff = Boolean(delegate?.turnIsLocal || delegate?.reason === 'local_model')
  const delegateWorkerDown = Boolean(delegate?.workerDownFallback)
  const delegateDisabled = delegate ? (delegate.busy || delegateLocalOff || (!delegate.available && !delegate.on)) : false
  const delegateChecked = delegateLocalOff ? false : Boolean(delegate?.on)
  const showLive = Boolean(liveRuntime && (running || liveRuntime.pending || liveRuntime.role === 'normal_after_worker_down' || liveRuntime.role === 'fallback' || liveRuntime.role === 'vision' || liveRuntime.mission?.status === 'running' || (liveRuntime.model && chipModelLabel(liveRuntime.model) !== (modelLabel || chipModelLabel(bot.model)))))
  const liveRoleLabel = (role: LiveRuntime['role']) => {
    switch (role) {
      case 'chef': return t('details.session.liveRoleChef')
      case 'worker': return t('details.session.liveRoleWorker')
      case 'vision': return t('details.session.liveRoleVision')
      case 'fallback': return t('details.session.liveRoleFallback')
      case 'normal_after_worker_down': return t('details.session.liveRoleNormalAfterDown')
      default: return ''
    }
  }
  const { features, routines: routineConfig } = useAppConfig()
  const workText = avatarPhase(bot) === 'working' ? workLine(work, bot.workTitle) : ''
  const [tab, setTab] = useState<Tab>(() => tabRequest?.tab ?? 'routines')
  // The Usage tab stays open from one bot to the next: that is where they get compared.
  useEffect(() => setTab((current) => current === 'usage' ? 'usage' : 'routines'), [bot.slug])
  useEffect(() => { if (tabRequest) setTab(tabRequest.tab) }, [tabRequest])
  const runningSubagents = subagents.filter(isEntryActive).length
  const active = routines.filter((routine) => routine.enabled).length
  // Messages between bots live in the thread (“Orion messaged Iris”), no longer in Activity. The bot's
  // steps, folded out of the thread, are kept here.
  const steps = useMemo(() => stepIds(messages, running, bot.slug), [messages, running, bot.slug])
  const activity = messages.filter((message) => steps.has(message.id) || (!message.agent && (message.technical || message.role === 'system' || message.role === 'tool'))).slice(-30).reverse()
  const activeDocument = documents.find((document) => document.id === railTab)
  const media = useMemo(() => conversationMedia(messages), [messages])
  const [viewer, setViewer] = useState<ViewerState | null>(null)
  const [editingRoutine, setEditingRoutine] = useState<Routine | null | false>(false)
  const [routineBusy, setRoutineBusy] = useState('')
  const [routineError, setRoutineError] = useState('')
  const closeViewer = useCallback(() => setViewer(null), [])
  const moveViewer = useCallback((index: number) => setViewer((current) => current && { ...current, index }), [])
  const onTabListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    const next = nextRovingIndex(tabs.length, tabs.indexOf(event.target as HTMLButtonElement), event.key)
    if (next === null) return
    event.preventDefault()
    if (tabs[next] === event.target) return
    tabs[next].focus()
    tabs[next].click()
  }
  const mutateRoutine = async (routine: Routine, action: 'pause' | 'resume' | 'run' | 'delete') => {
    const prompts = {
      pause: t('routines.confirmPause', { name: cleanRoutineName(routine.name, bot) }),
      resume: t('routines.confirmResume', { name: cleanRoutineName(routine.name, bot) }),
      run: t('routines.confirmRun', { name: cleanRoutineName(routine.name, bot) }),
      delete: t('routines.confirmDelete', { name: cleanRoutineName(routine.name, bot) }),
    }
    if (!routinesEditable || !window.confirm(prompts[action])) return
    setRoutineBusy(routine.id)
    setRoutineError('')
    try {
      if (action === 'pause') await pauseRoutine(bot.slug, routine.id)
      if (action === 'resume') await resumeRoutine(bot.slug, routine.id)
      if (action === 'run') await triggerRoutine(bot.slug, routine.id)
      if (action === 'delete') await deleteRoutine(bot.slug, routine.id)
      onReloadRoutines()
    } catch (cause) {
      setRoutineError(cause instanceof Error ? cause.message : t('routines.error.generic'))
    } finally {
      setRoutineBusy('')
    }
  }

  return (
    <aside className={`details-panel ${activeDocument ? 'has-document' : ''}`} aria-label={t('details.ariaLabel', { name: bot.name })}>
      <div className="details-topbar">
        <div className="rail-tabs" role="tablist" aria-orientation="horizontal" aria-label={t('details.railTabs')} onKeyDown={onTabListKey}>
          <div className={`rail-tab ${activeDocument ? '' : 'is-active'}`}>
            <button role="tab" tabIndex={activeDocument ? -1 : 0} aria-selected={!activeDocument} onClick={() => onSelectRailTab(BOT_RAIL_TAB)}>{t('details.botTab')}</button>
          </div>
          {documents.map((document) => (
            <div className={`rail-tab ${document.id === railTab ? 'is-active' : ''}`} key={document.id}>
              <button role="tab" tabIndex={document.id === railTab ? 0 : -1} aria-selected={document.id === railTab} title={document.path} onClick={() => onSelectRailTab(document.id)}><FileText size={12} /><span>{document.name}</span></button>
              <button className="rail-tab-close" aria-label={t('details.closeDocument', { name: document.name })} onClick={() => onCloseDocument(document.id)}><X size={11} /></button>
            </div>
          ))}
        </div>
        <button className="plain-icon" aria-label={t('details.close')} onClick={onClose}><X size={17} /></button>
      </div>
      {documents.map((document) => <DocumentView key={document.id} document={document} active={document.id === railTab} onReload={() => onReloadDocument(document.id)} />)}
      {!activeDocument && <div className="details-scroll">
        <div className="details-identity">
          <LiveAvatar bot={bot} size={72} showStatus />
          <div><h2>{bot.name}</h2><p>{statusLabel(effectiveStatus(bot))}{effectiveStatus(bot) === 'standby' && ` · ${backgroundSummary(bot.background)}`}</p></div>
        </div>
        <p className="details-role">{bot.role}</p>
        {workText && (
          <section className="work-card" aria-live="polite">
            <h3>{t('details.now')}</h3>
            <p>{workText}</p>
            {work?.task && work.note && <p>{work.note}</p>}
            {(work?.task || work?.note) && work?.step && <p>{work.step}</p>}
          </section>
        )}
        {(onOpenModels || compaction) && (
          <section className="details-session" aria-label={t('details.session.model')}>
            {onOpenModels && (
              <div className="details-session-model">
                <span className="details-session-label">{t('details.session.model')}</span>
                <button
                  type="button"
                  className="model-chip"
                  data-model-trigger="true"
                  aria-label={t('composer.chooseModel')}
                  aria-expanded={Boolean(modelPickerOpen)}
                  onClick={() => onOpenModels('')}
                >
                  <span>{modelLabel || bot.model}</span>
                  <ChevronDown size={13} aria-hidden="true" />
                </button>
              </div>
            )}
            {showLive && liveRuntime && (
              <div className="details-session-live" role="status" aria-live="polite" data-runtime-role={liveRuntime.role}>
                <div className="details-live-head">
                  <span className="details-session-label">{t('details.session.liveLabel')}</span>
                  <span className="details-live-value">
                    <span className="details-live-model" title={liveRuntime.model || undefined}>
                      {liveRuntime.pending
                        ? t('details.session.livePending')
                        : liveRuntime.model ? chipModelLabel(liveRuntime.model) : t('details.session.livePending')}
                    </span>
                    {!liveRuntime.pending && liveRoleLabel(liveRuntime.role) && (
                      <span className={`details-live-badge ${liveRuntime.role === 'normal_after_worker_down' || liveRuntime.role === 'fallback' ? 'is-warning' : ''}`}>
                        {liveRoleLabel(liveRuntime.role)}
                      </span>
                    )}
                  </span>
                </div>
                {!liveRuntime.pending && liveRuntime.attempt && liveRuntime.maxAttempts && liveRuntime.attempt > 1 && (
                  <span className="details-live-retry">{t('details.session.liveRetry', { attempt: liveRuntime.attempt, max: liveRuntime.maxAttempts })}</span>
                )}
                {liveRuntime.mission && liveRuntime.mission.status === 'running' && (
                  <span className="details-live-worker">
                    {liveRuntime.mission.seconds && liveRuntime.mission.seconds > 0
                      ? t('details.session.liveMissionRunningTimed', {
                        worker: liveRuntime.mission.workerLabel || (liveRuntime.mission.workerModel ? chipModelLabel(liveRuntime.mission.workerModel) : delegate?.worker || 'Worker'),
                        slot: liveRuntime.mission.slot,
                        seconds: Math.round(liveRuntime.mission.seconds),
                      })
                      : t('details.session.liveMissionRunning', {
                        worker: liveRuntime.mission.workerLabel || (liveRuntime.mission.workerModel ? chipModelLabel(liveRuntime.mission.workerModel) : delegate?.worker || 'Worker'),
                        slot: liveRuntime.mission.slot,
                      })}
                  </span>
                )}
                {liveRuntime.missions && liveRuntime.missions.filter((m) => m.status === 'running' && m.id !== liveRuntime.mission?.id).map((extra) => (
                  <span key={extra.id} className="details-live-worker">
                    {t('details.session.liveMissionRunning', {
                      worker: extra.workerLabel || (extra.workerModel ? chipModelLabel(extra.workerModel) : delegate?.worker || 'Worker'),
                      slot: extra.slot,
                    })}
                  </span>
                ))}
              </div>
            )}
            {delegate && (
              <div className={`details-session-delegate ${delegateChecked && !delegateWorkerDown ? 'is-on' : ''} ${delegateLocalOff ? 'is-local' : ''}`}>
                <div className="details-delegate-text">
                  <span className="details-session-label" id="details-delegate-label">{t('details.session.delegate')}</span>
                  <span className={`details-delegate-hint ${delegateWorkerDown ? 'is-warning' : ''}`} role={delegate.error ? 'alert' : undefined}>
                    {delegate.error
                      ? t('details.session.delegateFailed', { error: delegate.error })
                      : !delegate.available && !delegate.on
                        ? t('details.session.delegateUnavailable')
                        : delegateLocalOff
                          ? t('details.session.delegateLocalDisabled')
                          : delegateWorkerDown
                            ? t('details.session.delegateWorkerDownNormal')
                            : delegate.on
                              ? t('details.session.delegateOn', { chef: delegate.chef, worker: delegate.worker })
                              : t('details.session.delegateOff', { worker: delegate.worker })}
                  </span>
                  {delegate.available && !delegateLocalOff && !delegateWorkerDown && delegate.workerUp === false && (
                    <span className="details-worker-health is-offline" title={delegate.workerError || undefined}><i aria-hidden="true" />{t('details.session.delegateWorkerOffline')}</span>
                  )}
                </div>
                <input
                  className="settings-switch"
                  type="checkbox"
                  role="switch"
                  aria-labelledby="details-delegate-label"
                  aria-checked={delegateChecked}
                  checked={delegateChecked}
                  aria-disabled={delegateDisabled ? 'true' : undefined}
                  disabled={delegateDisabled}
                  onChange={(event) => delegate.onToggle(event.target.checked)}
                />
              </div>
            )}
            <div className="details-session-context">
              <div className="details-context-head">
                <span className="usage-readout" title={compaction?.tooltip || undefined}>{usageText}</span>
              </div>
              {shownContext && shownContext.contextMax > 0 && (
                <div
                  className={`details-context-meter ${compaction?.guard.level === 'full' ? 'is-full' : compaction?.guard.level === 'warn' ? 'is-warn' : ''}`}
                  role="meter"
                  aria-label={t('usage.contextUsed')}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(shownContext.contextPercent)}
                >
                  <i style={{ width: `${Math.min(100, shownContext.contextPercent)}%` }} />
                </div>
              )}
              {compaction && (
                <div className="details-context-actions">
                  <button
                    type="button"
                    className="details-compaction-mode"
                    title={compaction.tooltip || t('details.session.compactionSettings')}
                    onClick={compaction.onOpenSettings}
                  >
                    {compaction.mode === 'manual'
                      ? t('details.session.compactionManual', { percent: Math.round(compaction.gauge * 100) })
                      : t('details.session.compactionAuto')}
                  </button>
                  <button
                    type="button"
                    className="details-compact-button"
                    disabled={running || compaction.compacting || !(shownContext && shownContext.contextUsed > 0)}
                    onClick={compaction.onCompact}
                  >
                    {compaction.compacting ? t('compaction.compacting') : running ? t('compaction.afterTurn') : t('details.session.compact')}
                  </button>
                </div>
              )}
            </div>
          </section>
        )}
        <div className="details-tabs" role="tablist" aria-orientation="horizontal" aria-label={t('details.infoTabs')} onKeyDown={onTabListKey}>
          <button role="tab" tabIndex={tab === 'routines' ? 0 : -1} aria-selected={tab === 'routines'} className={tab === 'routines' ? 'is-active' : ''} onClick={(event) => { setTab('routines'); event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }}>{t('details.tabs.routines')}</button>
          {connectorsEnabled && <button role="tab" tabIndex={tab === 'connectors' ? 0 : -1} aria-selected={tab === 'connectors'} className={tab === 'connectors' ? 'is-active' : ''} onClick={(event) => { setTab('connectors'); event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }}>{t('details.tabs.connectors')}</button>}
          <button role="tab" tabIndex={tab === 'activity' ? 0 : -1} aria-selected={tab === 'activity'} className={tab === 'activity' ? 'is-active' : ''} onClick={(event) => { setTab('activity'); event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }}>{t('details.tabs.activity')}{activity.length > 0 && <span>{activity.length}</span>}</button>
          <button role="tab" tabIndex={tab === 'subagents' ? 0 : -1} aria-selected={tab === 'subagents'} className={tab === 'subagents' ? 'is-active' : ''} onClick={(event) => { setTab('subagents'); event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }}>{t('details.tabs.subagents')}{subagents.length > 0 && <span className={runningSubagents > 0 ? 'is-running' : ''}>{runningSubagents || subagents.length}</span>}</button>
          <button role="tab" tabIndex={tab === 'media' ? 0 : -1} aria-selected={tab === 'media'} className={tab === 'media' ? 'is-active' : ''} onClick={(event) => { setTab('media'); event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }}>{t('details.tabs.media')}</button>
          {computerPanelEnabled && <button role="tab" tabIndex={tab === 'computer' ? 0 : -1} aria-selected={tab === 'computer'} className={tab === 'computer' ? 'is-active' : ''} onClick={(event) => { setTab('computer'); event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }}><Monitor size={14} />{t('details.tabs.computer')}</button>}
          <button role="tab" tabIndex={tab === 'usage' ? 0 : -1} aria-selected={tab === 'usage'} className={tab === 'usage' ? 'is-active' : ''} onClick={(event) => { setTab('usage'); event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }}>{t('details.tabs.usage')}</button>
          {features.pagesLibrary && <button role="tab" tabIndex={tab === 'library' ? 0 : -1} aria-selected={tab === 'library'} className={tab === 'library' ? 'is-active' : ''} onClick={(event) => { setTab('library'); event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }}>{t('details.tabs.library')}</button>}
          <button role="tab" tabIndex={tab === 'about' ? 0 : -1} aria-selected={tab === 'about'} className={tab === 'about' ? 'is-active' : ''} onClick={(event) => { setTab('about'); event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }}>{t('details.tabs.about')}</button>
        </div>

        {tab === 'routines' && <section className="details-section">
          <div className="details-section-heading">
            <span>{t('details.tabs.routines')}</span>
            <span className="details-count">{t('routines.active', { count: active })}</span>
          </div>
          {routinesEditable && (
            <div className="routine-toolbar">
              <button type="button" className="is-primary" onClick={() => setEditingRoutine(null)}>{t('routines.create')}</button>
            </div>
          )}
          {loading && <div className="routine-loading"><span /><span /><span /></div>}
          {!loading && routines.length === 0 && <ViewEmpty variant="inline" description={t('routines.none')} role="status" />}
          {routineError && <p className="request-error" role="alert">{routineError}</p>}
          {!loading && routines.length > 0 && <div className="routine-card">{routines.map((routine) => (
            <article className={`routine-row ${routine.enabled ? '' : 'is-paused'}`} key={routine.id}>
              <div className="routine-icon"><Clock3 size={16} /></div>
              <div className="routine-copy">
                <h3>{cleanRoutineName(routine.name, bot)}</h3>
                <p>
                  {routineConfig.eventTriggers && routine.trigger && routine.trigger !== 'schedule'
                    ? t(`routines.trigger.${routine.trigger}`)
                    : routine.enabled ? `${dateTime(routine.nextRunAt)} · ${relativeTime(routine.nextRunAt)}` : t('routines.paused')}
                </p>
                <code>{routine.trigger === 'schedule' || !routine.trigger ? routine.schedule : t(`routines.triggerSummary.${routine.trigger}`)}</code>
                {routineConfig.eventTriggers && routine.runs && routine.runs.length > 0 && (
                  <ul className="routine-run-history">
                    {routine.runs.slice(0, 3).map((run) => (
                      <li key={`${run.at}-${run.source}`}>
                        {shortTime(run.at)} · {t('routines.runSource', { source: run.source })}{run.ok ? '' : ` · ${t('routines.runFailed')}`}
                      </li>
                    ))}
                  </ul>
                )}
                {routinesEditable && (
                  <div className="routine-actions">
                    <button type="button" disabled={routineBusy === routine.id} onClick={() => mutateRoutine(routine, routine.enabled ? 'pause' : 'resume')}>
                      {routine.enabled ? t('routines.pause') : t('routines.resume')}
                    </button>
                    <button type="button" disabled={routineBusy === routine.id} onClick={() => mutateRoutine(routine, 'run')}>{t('routines.runNow')}</button>
                    <button type="button" disabled={routineBusy === routine.id} onClick={() => setEditingRoutine(routine)}>{t('routines.edit')}</button>
                    <button type="button" disabled={routineBusy === routine.id} onClick={() => mutateRoutine(routine, 'delete')}>{t('routines.delete')}</button>
                  </div>
                )}
              </div>
              <span className={`routine-state ${routine.enabled ? 'is-on' : ''}`} aria-label={routine.enabled ? t('routines.stateActive') : t('routines.paused')} />
            </article>
          ))}</div>}
          {!routinesEditable && <p className="readonly-note">{t('routines.readonlyDisabled')}</p>}
          {routinesEditable && <p className="readonly-note">{t('routines.confirmHint')}</p>}
        </section>}

        {tab === 'connectors' && connectorsEnabled && <ConnectorsTab profile={bot.slug} client={client} enabled={connectorsEnabled} />}

        {tab === 'activity' && <section className="details-section activity-section">
          <div className="details-section-heading"><span>{t('details.activityHeading')}</span><Activity size={14} /></div>
          {activity.length === 0 && <ViewEmpty variant="inline" description={t('details.activityEmpty')} role="status" />}
          {activity.map((message) => (
            <article className={`activity-row ${steps.has(message.id) ? 'is-step' : ''}`} key={message.id}>
              <span>{shortTime(message.createdAt)}</span>
              <p>{message.content}</p>
            </article>
          ))}
        </section>}

        {tab === 'subagents' && <SubagentHistory entries={subagents} profile={bot.slug} onLoadTail={onLoadSubagentTail} onOpenImages={(images, index, version) => setViewer({ images, index, profile: bot.slug, version })} onOpenDocument={(item) => onOpenDocument(bot.slug, item)} />}

        {tab === 'media' && <section className="details-section media-section">
          <div className="details-section-heading"><span>{t('details.mediaHeading')}</span><span className="details-count"><Images size={13} /> {media.length}</span></div>
          {media.length === 0 && <ViewEmpty variant="inline" description={t('details.mediaEmpty')} role="status" />}
          {media.length > 0 && <MediaGallery items={media} profile={bot.slug} onOpenDocument={(item) => onOpenDocument(bot.slug, item)} />}
        </section>}

        {tab === 'computer' && computerPanelEnabled && <ComputerPanel bot={bot} onSteer={onComputerSteer} />}

        {tab === 'usage' && <UsageTab slug={bot.slug} sessionId={sessionId ?? bot.sessionId} configuredModel={sessionModel || bot.model} running={running} live={usage} load={loadUsageDetails} />}
        {tab === 'library' && features.pagesLibrary && onOpenLibraryPage && <PagesLibraryPanel profile={bot.slug} onOpen={onOpenLibraryPage} />}

        {tab === 'about' && <section className="details-section about-section">
          <div className="details-section-heading"><span>{t('details.tabs.about')}</span><Info size={14} /></div>
          <dl>
            <div><dt>{t('details.about.profile')}</dt><dd>{bot.slug}</dd></div>
            <div><dt>{t('details.about.model')}</dt><dd>{bot.model.replace('claude-', '').replaceAll('-', ' ')}</dd></div>
            <div><dt>{t('details.about.conversation')}</dt><dd>{t('details.about.permanentChat')}</dd></div>
          </dl>
        </section>}
      </div>}
      {viewer && <MediaViewer viewer={viewer} onClose={closeViewer} onMove={moveViewer} />}
      {editingRoutine !== false && routinesEditable && (
        <RoutineEditorDialog
          profile={bot.slug}
          routine={editingRoutine}
          eventTriggers={routineConfig.eventTriggers}
          onClose={() => setEditingRoutine(false)}
          onSaved={onReloadRoutines}
        />
      )}
    </aside>
  )
}
