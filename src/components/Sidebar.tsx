import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { Bell, Check, CheckCheck, ChevronDown, ChevronRight, Eye, EyeOff, Moon, Plus, RefreshCw, Search, Settings, Sun, User, X } from 'lucide-react'
import type { Bot } from '../types'
import { avatarColor, statusLabel } from './BotAvatar'
import { LiveAvatar, avatarPhase } from './LiveAvatar'
import { cleanPreview, shortTime } from '../lib/time'
import { compareBotActivity, latestActivity } from '../lib/activity'
import { workLine, type WorkSummary } from '../lib/work-summary'
import { updateSettings, useSettings } from '../lib/settings'
import { compareSections, useAppConfig } from '../lib/app-config'
import { locale } from '../i18n'

// “Non classés” (the roster’s name for unsorted bots), then the local chat, close the list unless the configuration places them elsewhere.
const TRAILING_SECTIONS = ['Non classés', 'Local']
// These two names are sort keys from the roster data; only their label follows the language.
const SECTION_LABELS: Record<string, string> = { 'Non classés': 'sidebar.sectionUnassigned', Local: 'sidebar.sectionLocal' }

interface SidebarProps {
  bots: Bot[]
  selected: string
  connected: boolean
  reconnecting: boolean
  onReconnect: () => void
  onLogout: () => void
  workSummaries: Record<string, WorkSummary>
  dark: boolean
  mobileOpen: boolean
  onCloseMobile: () => void
  onSelect: (bot: Bot) => void
  onNewMessage: () => void
  onToggleTheme: (origin?: { x: number; y: number }) => void
  onOpenSettings: () => void
}

export function Sidebar({ bots, selected, connected, reconnecting, onReconnect, onLogout, workSummaries, dark, mobileOpen, onCloseMobile, onSelect, onNewMessage, onToggleTheme, onOpenSettings }: SidebarProps) {
  const { t } = useTranslation()
  const { activitySort, showHidden } = useSettings()
  const { ui } = useAppConfig()
  const [searchOpen, setSearchOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [workingOnly, setWorkingOnly] = useState(false)
  const busyBots = useMemo(() => bots.filter((bot) => !bot.hidden && avatarPhase(bot) === 'working'), [bots])
  useEffect(() => { if (busyBots.length === 0) setWorkingOnly(false) }, [busyBots.length])
  const listRef = useRef<HTMLElement>(null)
  const chooseSort = (activity: boolean) => {
    updateSettings({ activitySort: activity })
    listRef.current?.scrollTo({ top: 0 })
  }

  const groups = useMemo<[string, Bot[]][]>(() => {
    const needle = search.trim().toLocaleLowerCase(locale())
    const visible = bots.filter((bot) => {
      if (!showHidden && bot.hidden) return false
      if (unreadOnly && bot.unread === 0) return false
      if (workingOnly && avatarPhase(bot) !== 'working') return false
      if (needle && !`${bot.name} ${bot.role} ${bot.preview}`.toLocaleLowerCase(locale()).includes(needle)) return false
      return true
    })
    // By activity: a single list, no sections.
    if (activitySort) return visible.length ? [['', visible.sort(compareBotActivity)]] : []
    const map = new Map<string, Bot[]>()
    visible.forEach((bot) => map.set(bot.section, [...(map.get(bot.section) || []), bot]))
    const order = compareSections(ui.sectionOrder, TRAILING_SECTIONS)
    return [...map.entries()].sort(([a], [b]) => order(a, b))
  }, [bots, search, showHidden, unreadOnly, workingOnly, activitySort, ui.sectionOrder])

  const unread = bots.reduce((total, bot) => total + bot.unread, 0)
  const toggleSection = (section: string) => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(section)) next.delete(section)
      else next.add(section)
      return next
    })
  }

  return (
    <>
      {mobileOpen && <button className="sidebar-scrim" aria-label={t('sidebar.closeNav')} onClick={onCloseMobile} />}
      <aside className={`sidebar ${mobileOpen ? 'mobile-open' : ''}`} aria-label={t('sidebar.bots')}>
        <div className="sidebar-topbar">
          <div className="window-drag-space" />
          <div className="sidebar-actions">
            <button className={`round-icon-button ${searchOpen ? 'is-active' : ''}`} aria-label={t('sidebar.searchBot')} onClick={() => setSearchOpen((open) => !open)}>
              {searchOpen ? <X size={17} /> : <Search size={17} />}
            </button>
            <button className="round-icon-button" aria-label={t('sidebar.writeToBot')} onClick={onNewMessage}><Plus size={19} /></button>
          </div>
        </div>

        {searchOpen && (
          <div className="sidebar-search-wrap">
            <Search size={15} />
            <input
              className="sidebar-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('sidebar.search')}
              aria-label={t('sidebar.searchIn')}
              autoFocus
            />
            {search && <button className="plain-icon" aria-label={t('sidebar.clearSearch')} onClick={() => setSearch('')}><X size={14} /></button>}
          </div>
        )}

        <button
          className={`working-strip ${busyBots.length ? 'has-work' : ''} ${workingOnly ? 'is-active' : ''}`}
          onClick={() => setWorkingOnly((value) => !value)}
          disabled={busyBots.length === 0}
          aria-pressed={workingOnly}
          aria-label={busyBots.length ? t('sidebar.workingAria', { count: busyBots.length, action: workingOnly ? t('sidebar.actionShowAll') : t('sidebar.actionOnlyThem') }) : t('sidebar.noneWorkingAria')}
        >
          <span className="working-strip-pulse" aria-hidden="true" />
          {busyBots.length > 0 && <span className="working-strip-avatars">{busyBots.slice(0, 4).map((bot) => <LiveAvatar key={bot.slug} bot={bot} size={20} />)}</span>}
          <span className="working-strip-text">{busyBots.length ? t('sidebar.workingCount', { count: busyBots.length }) : t('sidebar.allAvailable')}</span>
          {busyBots.length > 0 && <span className="working-strip-action">{workingOnly ? t('sidebar.showAll') : t('sidebar.view')}</span>}
        </button>

        <div className="sidebar-filter-row">
          <span>{t('sidebar.botCount', { count: bots.filter((bot) => !bot.hidden).length })}</span>
          <div className="sidebar-filter-actions">
            <div className="sort-switch" role="group" aria-label={t('sidebar.sortBots')}>
              <button className={activitySort ? '' : 'is-active'} aria-pressed={!activitySort} onClick={() => chooseSort(false)}>{t('sidebar.groups')}</button>
              <button className={activitySort ? 'is-active' : ''} aria-pressed={activitySort} onClick={() => chooseSort(true)}>{t('sidebar.activity')}</button>
            </div>
            <button className={`unread-filter ${unreadOnly ? 'is-active' : ''}`} onClick={() => setUnreadOnly((value) => !value)} aria-pressed={unreadOnly}>
              {unreadOnly ? <CheckCheck size={14} /> : <Bell size={14} />}
              {t('sidebar.unread')}{unread > 0 && <span className="filter-count">{unread}</span>}
            </button>
          </div>
        </div>

        <nav className="bot-list" ref={listRef}>
          {groups.map(([section, sectionBots]) => (
            <section className="bot-section" key={activitySort ? 'activity' : section}>
              {!activitySort && (
                <button className="section-heading" onClick={() => toggleSection(section)} aria-expanded={!collapsed.has(section)}>
                  {collapsed.has(section) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                  <span>{SECTION_LABELS[section] ? t(SECTION_LABELS[section]) : section}</span>
                  <span className="section-count">{sectionBots.length}</span>
                </button>
              )}
              {(activitySort || !collapsed.has(section)) && sectionBots.map((bot) => {
                const phase = avatarPhase(bot)
                const work = phase === 'working' ? workLine(workSummaries[bot.slug], bot.workTitle) : ''
                return (
                  <button
                    className={`bot-row is-${phase} status-${bot.status} ${selected === bot.slug ? 'is-selected' : ''} ${bot.hidden ? 'is-hidden' : ''}`}
                    key={bot.slug}
                    data-bot={bot.slug}
                    style={{ '--avatar-color': avatarColor(bot) } as CSSProperties}
                    onClick={() => onSelect(bot)}
                    aria-current={selected === bot.slug ? 'page' : undefined}
                  >
                    <LiveAvatar bot={bot} size={36} />
                    <span className="bot-row-copy">
                      <span className="bot-row-line">
                        <span className="bot-row-name">{bot.name}</span>
                        <span className="bot-row-time">{shortTime(activitySort ? latestActivity(bot) : bot.timestamp)}</span>
                      </span>
                      <span className="bot-row-line bot-row-preview-line">
                        {phase === 'working' && <span className="bot-row-status is-working">{statusLabel(bot.status)}<span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>{work && <span className="bot-row-work" title={work}>{work}</span>}</span>}
                        {phase === 'done' && <span className="bot-row-status is-done"><Check size={12} strokeWidth={2.6} />{statusLabel(bot.status)}</span>}
                        {(bot.status === 'waiting' || bot.status === 'blocked') && <span className={`bot-row-status is-${bot.status}`}><span className="status-dot" aria-hidden="true" />{statusLabel(bot.status)}</span>}
                        {phase === 'idle' && bot.status !== 'waiting' && bot.status !== 'blocked' && <span className="bot-row-preview">{cleanPreview(bot.preview) || bot.role}</span>}
                        {bot.unread > 0 && <span className="unread-badge">{bot.unread > 9 ? '9+' : bot.unread}</span>}
                      </span>
                    </span>
                  </button>
                )
              })}
            </section>
          ))}
          {groups.length === 0 && (
            <div className="sidebar-empty">
              <span>{t('sidebar.noBotFound')}</span>
              <button onClick={() => { setSearch(''); setUnreadOnly(false); updateSettings({ showHidden: true }) }}>{t('sidebar.resetFilters')}</button>
            </div>
          )}
        </nav>

        <div className="sidebar-footer">
          <div className="connection-status">
            <div className="connection-label"><span className={`connection-dot ${connected ? 'is-connected' : ''}`} /><span>{reconnecting ? t('sidebar.reconnecting') : connected ? t('sidebar.connected') : t('sidebar.disconnected')}</span></div>
            <button className={`connection-refresh ${connected ? '' : 'is-offline'} ${reconnecting ? 'is-busy' : ''}`} aria-label={t('sidebar.reconnectHermes')} title={t('sidebar.reconnectHermes')} disabled={reconnecting} onClick={onReconnect}>
              <RefreshCw size={13} />
            </button>
          </div>
          <div className="footer-actions">
            {bots.some((bot) => bot.hidden) && <button className="plain-icon" aria-label={showHidden ? t('sidebar.hideHidden') : t('sidebar.showHidden')} onClick={() => updateSettings({ showHidden: !showHidden })}>{showHidden ? <EyeOff size={16} /> : <Eye size={16} />}</button>}
            <button className="plain-icon" aria-label={t('sidebar.settings')} title={t('sidebar.settingsTitle')} onClick={onOpenSettings}><Settings size={16} /></button>
            <button className="plain-icon" aria-label={dark ? t('sidebar.lightTheme') : t('sidebar.darkTheme')} onClick={(event) => onToggleTheme({ x: event.clientX, y: event.clientY })}>{dark ? <Sun size={16} /> : <Moon size={16} />}</button>
            <button className="user-menu" aria-label={t('sidebar.signOut')} title={t('sidebar.signOut')} onClick={onLogout}>{ui.userInitial ? <span className="user-avatar" aria-label={ui.userName || ui.userInitial}>{ui.userInitial}</span> : <span className="user-avatar" aria-hidden="true"><User size={14} /></span>}</button>
          </div>
        </div>
      </aside>
    </>
  )
}
