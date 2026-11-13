import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Bell, Check, CheckCheck, ChevronDown, ChevronRight, Eye, EyeOff, Plus, RefreshCw, Search, Settings, User, X } from 'lucide-react'
import type { Bot } from '../types'
import { BotContextMenu } from './BotContextMenu'
import { DeleteBotDialog, RenameBotDialog } from './BotDialogs'
import { avatarColor, statusLabel } from './BotAvatar'
import { LiveAvatar, avatarPhase } from './LiveAvatar'
import { cleanPreview, shortTime } from '../lib/time'
import { latestActivity } from '../lib/activity'
import { workLine, type WorkSummary } from '../lib/work-summary'
import { updateSettings, useSettings } from '../lib/settings'
import { compareSections, useAppConfig } from '../lib/app-config'
import { backgroundSummary } from '../lib/background'
import { botActionError, type BotAction } from '../lib/bot-actions'
import { LOCAL_CHAT_SLUG } from '../lib/local-chat'
import { botSections, LOCAL_SECTION_NAME, rosterGroups, UNASSIGNED_SECTION_NAME } from '../lib/roster-groups'
import { locale } from '../i18n'

// “Non classés” (the roster’s name for unsorted bots), then the local chat, close the list unless the configuration places them elsewhere.
const TRAILING_SECTIONS = [UNASSIGNED_SECTION_NAME, LOCAL_SECTION_NAME]
// These two names are sort keys from the roster data; only their label follows the language.
const SECTION_LABELS: Record<string, string> = { [UNASSIGNED_SECTION_NAME]: 'sidebar.sectionUnassigned', [LOCAL_SECTION_NAME]: 'sidebar.sectionLocal' }

interface SidebarProps {
  bots: Bot[]
  selected: string
  connected: boolean
  reconnecting: boolean
  onReconnect: () => void
  onLogout: () => void
  workSummaries: Record<string, WorkSummary>
  mobileOpen: boolean
  onCloseMobile: () => void
  onSelect: (bot: Bot) => void
  /** Opens the new bot dialog. */
  onNewBot: () => void
  onOpenSettings: () => void
  /** Hermes answers (or the demo runs): the menu offers the actions that write to it. */
  canManage: boolean
  /** Runs a bot menu action; rejects when Hermes did not take it. */
  onBotAction: (bot: Bot, action: BotAction) => Promise<void>
  onNotice: (message: string) => void
}

export function Sidebar({ bots, selected, connected, reconnecting, onReconnect, onLogout, workSummaries, mobileOpen, onCloseMobile, onSelect, onNewBot, onOpenSettings, canManage, onBotAction, onNotice }: SidebarProps) {
  const { t } = useTranslation()
  const { activitySort, showHidden, pinnedBots } = useSettings()
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

  const sectionOrder = useMemo(() => compareSections(ui.sectionOrder, TRAILING_SECTIONS), [ui.sectionOrder])
  const groups = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase(locale())
    const visible = bots.filter((bot) => {
      if (!showHidden && bot.hidden) return false
      if (unreadOnly && bot.unread === 0) return false
      if (workingOnly && avatarPhase(bot) !== 'working') return false
      if (needle && !`${bot.name} ${bot.role} ${bot.preview}`.toLocaleLowerCase(locale()).includes(needle)) return false
      return true
    })
    // Pinned bots first, then by activity a single list with no sections, or one group per section.
    return rosterGroups(visible, { pinned: pinnedBots, activitySort, compareSections: sectionOrder })
  }, [bots, search, showHidden, unreadOnly, workingOnly, activitySort, sectionOrder, pinnedBots])

  // Right-click menu and its two dialogs. Kept by slug: the row's bot changes with every roster read.
  const [menu, setMenu] = useState<{ slug: string; at: { x: number; y: number } } | null>(null)
  const [dialog, setDialog] = useState<{ kind: 'rename' | 'delete'; slug: string } | null>(null)
  const menuBot = menu ? bots.find((bot) => bot.slug === menu.slug) : undefined
  const dialogBot = dialog ? bots.find((bot) => bot.slug === dialog.slug) : undefined
  const sections = useMemo(() => botSections(bots, sectionOrder), [bots, sectionOrder])
  // A bot that left the roster (deleted, here or elsewhere) takes its menu and dialog with it.
  useEffect(() => { if (menu && !menuBot) setMenu(null) }, [menu, menuBot])
  useEffect(() => { if (dialog && !dialogBot) setDialog(null) }, [dialog, dialogBot])
  const openMenu = (event: MouseEvent<HTMLElement>, bot: Bot) => {
    event.preventDefault()
    // From the keyboard (context menu key, ⇧F10) the point is not on the row: the menu opens under it.
    const row = event.currentTarget.getBoundingClientRect()
    const onRow = event.clientX >= row.left && event.clientX <= row.right && event.clientY >= row.top && event.clientY <= row.bottom
    setMenu({ slug: bot.slug, at: onRow ? { x: event.clientX, y: event.clientY } : { x: row.left + 28, y: row.bottom - 6 } })
  }
  const menuSlug = useRef('')
  menuSlug.current = menu?.slug ?? ''
  const closeMenu = useCallback((restoreFocus: boolean) => {
    const slug = menuSlug.current
    setMenu(null)
    // Back to the row it was opened on, so the keyboard carries on from there.
    if (slug && restoreFocus) setTimeout(() => listRef.current?.querySelector<HTMLElement>(`[data-bot="${CSS.escape(slug)}"]`)?.focus({ preventScroll: true }), 0)
  }, [])
  const runMenuAction = (bot: Bot, action: BotAction) => {
    onBotAction(bot, action).catch((error: unknown) => onNotice(botActionError(error)))
  }

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
            <button className="round-icon-button" aria-label={t('sidebar.newBot')} title={t('sidebar.newBot')} disabled={!canManage} onClick={onNewBot}><Plus size={19} /></button>
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
          {groups.map(({ key, section, pinned, bots: sectionBots }) => (
            <section className={`bot-section${pinned ? ' is-pinned' : ''}`} key={key}>
              {(!activitySort || pinned) && (
                <button className="section-heading" onClick={() => toggleSection(key)} aria-expanded={!collapsed.has(key)}>
                  {collapsed.has(key) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                  <span>{pinned ? t('sidebar.sectionPinned') : SECTION_LABELS[section] ? t(SECTION_LABELS[section]) : section}</span>
                  <span className="section-count">{sectionBots.length}</span>
                </button>
              )}
              {((activitySort && !pinned) || !collapsed.has(key)) && sectionBots.map((bot) => {
                const phase = avatarPhase(bot)
                const work = phase === 'working' ? workLine(workSummaries[bot.slug], bot.workTitle) : ''
                // Standing by: what still runs is told on hover, the row keeps its last message.
                const standby = phase === 'standby' ? backgroundSummary(bot.background) : ''
                return (
                  <button
                    className={`bot-row is-${phase} status-${bot.status} ${selected === bot.slug ? 'is-selected' : ''} ${bot.hidden ? 'is-hidden' : ''}`}
                    key={bot.slug}
                    data-bot={bot.slug}
                    style={{ '--avatar-color': avatarColor(bot) } as CSSProperties}
                    onClick={() => onSelect(bot)}
                    // The local chat is not a Hermes profile: nothing to pin, move, rename or delete.
                    onContextMenu={bot.slug === LOCAL_CHAT_SLUG ? undefined : (event) => openMenu(event, bot)}
                    aria-current={selected === bot.slug ? 'page' : undefined}
                    title={standby || undefined}
                  >
                    <LiveAvatar bot={bot} size={36} />
                    <span className="bot-row-copy">
                      <span className="bot-row-line">
                        <span className="bot-row-name">{bot.name}</span>
                        <span className="bot-row-time">{shortTime(activitySort ? latestActivity(bot) : bot.timestamp)}</span>
                      </span>
                      <span className="bot-row-line bot-row-preview-line">
                        {phase === 'working' && <span className="bot-row-status is-working">{statusLabel(bot.status)}<span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>{work && <span className="bot-row-work" title={work}>{work}</span>}</span>}
                        {phase === 'standby' && <span className="bot-row-status is-standby"><span className="status-dot" aria-hidden="true" />{statusLabel('standby')}<span className="visually-hidden"> · {standby}</span>{cleanPreview(bot.preview) && <span className="bot-row-work">{cleanPreview(bot.preview)}</span>}</span>}
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
            <button className="user-menu" aria-label={t('sidebar.signOut')} title={t('sidebar.signOut')} onClick={onLogout}>{ui.userInitial ? <span className="user-avatar" aria-label={ui.userName || ui.userInitial}>{ui.userInitial}</span> : <span className="user-avatar" aria-hidden="true"><User size={14} /></span>}</button>
          </div>
        </div>
      </aside>
      {menu && menuBot && (
        <BotContextMenu
          bot={menuBot}
          at={menu.at}
          pinned={pinnedBots.includes(menuBot.slug)}
          sections={sections}
          canManage={canManage}
          onAction={(action) => runMenuAction(menuBot, action)}
          onRename={() => setDialog({ kind: 'rename', slug: menuBot.slug })}
          onDelete={() => setDialog({ kind: 'delete', slug: menuBot.slug })}
          onClose={closeMenu}
        />
      )}
      {dialog?.kind === 'rename' && dialogBot && <RenameBotDialog bot={dialogBot} onRename={(title) => onBotAction(dialogBot, { type: 'rename', title })} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'delete' && dialogBot && <DeleteBotDialog bot={dialogBot} onDelete={() => onBotAction(dialogBot, { type: 'delete' })} onClose={() => setDialog(null)} />}
    </>
  )
}
