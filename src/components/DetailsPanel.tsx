import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, Clock3, FileText, Images, Info, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Bot, ChatMessage, Routine, SessionUsage } from '../types'
import { statusLabel } from './BotAvatar'
import { LiveAvatar, avatarPhase } from './LiveAvatar'
import { DocumentView, type OpenDocument } from './DocumentView'
import { MediaEmbed, MediaViewer, type ViewerState } from './MediaEmbed'
import { UsageTab, type UsageDetails } from './UsageTab'
import { dateTime, relativeTime, shortTime } from '../lib/time'
import { conversationMedia, type MediaRef } from '../lib/media'
import { workLine, type WorkSummary } from '../lib/work-summary'
import { backgroundSummary, effectiveStatus } from '../lib/background'

function cleanRoutineName(name: string, bot: Bot) {
  const strip = (value: string, prefix: string) =>
    value.toLowerCase().startsWith(prefix.toLowerCase()) ? value.slice(prefix.length).trimStart() : value
  return strip(strip(name, `[bot:${bot.slug}]`), `${bot.name}:`)
}

type Tab = 'routines' | 'activity' | 'media' | 'usage' | 'about'

export const BOT_RAIL_TAB = 'bot'

interface DetailsPanelProps {
  bot: Bot
  work?: WorkSummary
  routines: Routine[]
  messages: ChatMessage[]
  loading: boolean
  running: boolean
  usage: SessionUsage | null
  loadUsageDetails: () => Promise<UsageDetails>
  onOpenDocument: (profile: string, media: MediaRef) => void
  documents: OpenDocument[]
  railTab: string
  onSelectRailTab: (tab: string) => void
  onCloseDocument: (id: string) => void
  onReloadDocument: (id: string) => void
  onClose: () => void
}

export function DetailsPanel({ bot, work, routines, messages, loading, running, usage, loadUsageDetails, onOpenDocument, documents, railTab, onSelectRailTab, onCloseDocument, onReloadDocument, onClose }: DetailsPanelProps) {
  const { t } = useTranslation()
  const workText = avatarPhase(bot) === 'working' ? workLine(work, bot.workTitle) : ''
  const [tab, setTab] = useState<Tab>('routines')
  // The Usage tab stays open from one bot to the next: that is where they get compared.
  useEffect(() => setTab((current) => current === 'usage' ? 'usage' : 'routines'), [bot.slug])
  const active = routines.filter((routine) => routine.enabled).length
  // Messages between bots live in the thread (“Orion messaged Iris”), no longer in Activity.
  const activity = messages.filter((message) => !message.agent && (message.technical || message.role === 'system' || message.role === 'tool')).slice(-30).reverse()
  const activeDocument = documents.find((document) => document.id === railTab)
  const media = useMemo(() => conversationMedia(messages), [messages])
  const [viewer, setViewer] = useState<ViewerState | null>(null)
  const closeViewer = useCallback(() => setViewer(null), [])
  const moveViewer = useCallback((index: number) => setViewer((current) => current && { ...current, index }), [])
  const openImage = (item: MediaRef, version: string) => {
    const images = media.filter((entry) => entry.ref.kind === 'image').map((entry) => entry.ref)
    setViewer({ images, index: Math.max(0, images.indexOf(item)), profile: bot.slug, version })
  }
  return (
    <aside className={`details-panel ${activeDocument ? 'has-document' : ''}`} aria-label={t('details.ariaLabel', { name: bot.name })}>
      <div className="details-topbar">
        <div className="rail-tabs" role="tablist" aria-label={t('details.railTabs')}>
          <div className={`rail-tab ${activeDocument ? '' : 'is-active'}`}>
            <button role="tab" aria-selected={!activeDocument} onClick={() => onSelectRailTab(BOT_RAIL_TAB)}>{t('details.botTab')}</button>
          </div>
          {documents.map((document) => (
            <div className={`rail-tab ${document.id === railTab ? 'is-active' : ''}`} key={document.id}>
              <button role="tab" aria-selected={document.id === railTab} title={document.path} onClick={() => onSelectRailTab(document.id)}><FileText size={12} /><span>{document.name}</span></button>
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
        <div className="details-tabs" role="tablist" aria-label={t('details.infoTabs')}>
          <button role="tab" aria-selected={tab === 'routines'} className={tab === 'routines' ? 'is-active' : ''} onClick={() => setTab('routines')}>{t('details.tabs.routines')}</button>
          <button role="tab" aria-selected={tab === 'activity'} className={tab === 'activity' ? 'is-active' : ''} onClick={() => setTab('activity')}>{t('details.tabs.activity')}{activity.length > 0 && <span>{activity.length}</span>}</button>
          <button role="tab" aria-selected={tab === 'media'} className={tab === 'media' ? 'is-active' : ''} onClick={() => setTab('media')}>{t('details.tabs.media')}</button>
          <button role="tab" aria-selected={tab === 'usage'} className={tab === 'usage' ? 'is-active' : ''} onClick={() => setTab('usage')}>{t('details.tabs.usage')}</button>
          <button role="tab" aria-selected={tab === 'about'} className={tab === 'about' ? 'is-active' : ''} onClick={() => setTab('about')}>{t('details.tabs.about')}</button>
        </div>

        {tab === 'routines' && <section className="details-section">
          <div className="details-section-heading"><span>{t('details.tabs.routines')}</span><span className="details-count">{t('routines.active', { count: active })}</span></div>
          {loading && <div className="routine-loading"><span /><span /><span /></div>}
          {!loading && routines.length === 0 && <p className="details-empty">{t('routines.none')}</p>}
          {!loading && routines.length > 0 && <div className="routine-card">{routines.map((routine) => (
            <article className={`routine-row ${routine.enabled ? '' : 'is-paused'}`} key={routine.id}>
              <div className="routine-icon"><Clock3 size={16} /></div>
              <div className="routine-copy">
                <h3>{cleanRoutineName(routine.name, bot)}</h3>
                <p>{routine.enabled ? `${dateTime(routine.nextRunAt)} · ${relativeTime(routine.nextRunAt)}` : t('routines.paused')}</p>
                <code>{routine.schedule}</code>
              </div>
              <span className={`routine-state ${routine.enabled ? 'is-on' : ''}`} aria-label={routine.enabled ? t('routines.stateActive') : t('routines.paused')} />
            </article>
          ))}</div>}
          <p className="readonly-note">{t('routines.readonly')}</p>
        </section>}

        {tab === 'activity' && <section className="details-section activity-section">
          <div className="details-section-heading"><span>{t('details.activityHeading')}</span><Activity size={14} /></div>
          {activity.length === 0 && <p className="details-empty">{t('details.activityEmpty')}</p>}
          {activity.map((message) => (
            <article className="activity-row" key={message.id}>
              <span>{shortTime(message.createdAt)}</span>
              <p>{message.content}</p>
            </article>
          ))}
        </section>}

        {tab === 'media' && <section className="details-section media-section">
          <div className="details-section-heading"><span>{t('details.mediaHeading')}</span><span className="details-count"><Images size={13} /> {media.length}</span></div>
          {media.length === 0 && <p className="details-empty">{t('details.mediaEmpty')}</p>}
          <div className="media-library">
            {media.map(({ ref, version }) => <MediaEmbed key={ref.path} media={ref} profile={bot.slug} version={version} onOpenImage={(item) => openImage(item, version)} onOpenDocument={(item) => onOpenDocument(bot.slug, item)} />)}
          </div>
        </section>}

        {tab === 'usage' && <UsageTab slug={bot.slug} running={running} live={usage} load={loadUsageDetails} />}

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
    </aside>
  )
}
