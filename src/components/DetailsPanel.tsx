import { useEffect, useState } from 'react'
import { Activity, Clock3, Info, X } from 'lucide-react'
import type { Bot, ChatMessage, Routine } from '../types'
import { statusLabel } from './BotAvatar'
import { LiveAvatar, avatarPhase } from './LiveAvatar'
import { dateTime, relativeTime, shortTime } from '../lib/time'
import { workLine, type WorkSummary } from '../lib/work-summary'

function cleanRoutineName(name: string, bot: Bot) {
  const strip = (value: string, prefix: string) =>
    value.toLowerCase().startsWith(prefix.toLowerCase()) ? value.slice(prefix.length).trimStart() : value
  return strip(strip(name, `[bot:${bot.slug}]`), `${bot.name}:`)
}

type Tab = 'routines' | 'activity' | 'about'

interface DetailsPanelProps {
  bot: Bot
  work?: WorkSummary
  routines: Routine[]
  messages: ChatMessage[]
  loading: boolean
  onClose: () => void
}

export function DetailsPanel({ bot, work, routines, messages, loading, onClose }: DetailsPanelProps) {
  const workText = avatarPhase(bot) === 'working' ? workLine(work, bot.workTitle) : ''
  const [tab, setTab] = useState<Tab>('routines')
  useEffect(() => setTab('routines'), [bot.slug])
  const active = routines.filter((routine) => routine.enabled).length
  const activity = messages.filter((message) => message.technical || message.role === 'system' || message.role === 'tool').slice(-30).reverse()
  return (
    <aside className="details-panel" aria-label={`Détails de ${bot.name}`}>
      <div className="details-topbar">
        <span>Le bot</span>
        <button className="plain-icon" aria-label="Fermer les détails" onClick={onClose}><X size={17} /></button>
      </div>
      <div className="details-scroll">
        <div className="details-identity">
          <LiveAvatar bot={bot} size={72} showStatus />
          <div><h2>{bot.name}</h2><p>{statusLabel(bot.status)}</p></div>
        </div>
        <p className="details-role">{bot.role}</p>
        {workText && (
          <section className="work-card" aria-live="polite">
            <h3>En ce moment</h3>
            <p>{workText}</p>
            {work?.task && work.note && <p>{work.note}</p>}
            {(work?.task || work?.note) && work?.step && <p>{work.step}</p>}
          </section>
        )}
        <div className="details-tabs" role="tablist" aria-label="Informations du bot">
          <button role="tab" aria-selected={tab === 'routines'} className={tab === 'routines' ? 'is-active' : ''} onClick={() => setTab('routines')}>Routines</button>
          <button role="tab" aria-selected={tab === 'activity'} className={tab === 'activity' ? 'is-active' : ''} onClick={() => setTab('activity')}>Activité{activity.length > 0 && <span>{activity.length}</span>}</button>
          <button role="tab" aria-selected={tab === 'about'} className={tab === 'about' ? 'is-active' : ''} onClick={() => setTab('about')}><Info size={13} />À propos</button>
        </div>

        {tab === 'routines' && <section className="details-section">
          <div className="details-section-heading"><span>Routines</span><span className="details-count">{active} actives</span></div>
          {loading && <div className="routine-loading"><span /><span /><span /></div>}
          {!loading && routines.length === 0 && <p className="details-empty">Aucune routine pour ce bot.</p>}
          {!loading && routines.length > 0 && <div className="routine-card">{routines.map((routine) => (
            <article className={`routine-row ${routine.enabled ? '' : 'is-paused'}`} key={routine.id}>
              <div className="routine-icon"><Clock3 size={16} /></div>
              <div className="routine-copy">
                <h3>{cleanRoutineName(routine.name, bot)}</h3>
                <p>{routine.enabled ? `${dateTime(routine.nextRunAt)} · ${relativeTime(routine.nextRunAt)}` : 'En pause'}</p>
                <code>{routine.schedule}</code>
              </div>
              <span className={`routine-state ${routine.enabled ? 'is-on' : ''}`} aria-label={routine.enabled ? 'Active' : 'En pause'} />
            </article>
          ))}</div>}
          <p className="readonly-note">Lecture seule. Aucune routine ne peut être activée ici.</p>
        </section>}

        {tab === 'activity' && <section className="details-section activity-section">
          <div className="details-section-heading"><span>Activité technique</span><Activity size={14} /></div>
          {activity.length === 0 && <p className="details-empty">Aucune activité technique à afficher.</p>}
          {activity.map((message) => (
            <article className="activity-row" key={message.id}>
              <span>{shortTime(message.createdAt)}</span>
              <p>{message.content}</p>
            </article>
          ))}
        </section>}

        {tab === 'about' && <section className="details-section about-section">
          <div className="details-section-heading"><span>À propos</span><Info size={14} /></div>
          <dl>
            <div><dt>Profil</dt><dd>{bot.slug}</dd></div>
            <div><dt>Modèle</dt><dd>{bot.model.replace('claude-', '').replaceAll('-', ' ')}</dd></div>
            <div><dt>Conversation</dt><dd>Bot Chat permanent</dd></div>
          </dl>
        </section>}
      </div>
    </aside>
  )
}
