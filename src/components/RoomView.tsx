import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, Menu, Pause, RotateCcw, RotateCw, UsersRound, X } from 'lucide-react'
import type { Bot } from '../types'
import type { PendingRoomSend } from '../store/rooms'
import { roomTimeline, type Room, type RoomDriverStatus, type RoomEvent, type RoomMember, type RoomMemberActivity } from '../lib/rooms'
import { mentionIndex, mentionOptions, mentionTokenAt, resolveMentions } from '../lib/mentions'
import { toolLabel } from '../lib/work-summary'
import { messageDay, shortTime } from '../lib/time'
import { BotAvatar, avatarColor } from './BotAvatar'
import { LiveAvatar } from './LiveAvatar'
import { Markdown, MentionContext, type MentionContextValue } from './MessageList'
import './RoomView.css'

interface RoomViewProps {
  room: Room
  bots: Bot[]
  events: RoomEvent[]
  driver: RoomDriverStatus | null
  loading: boolean
  error: string
  pending: PendingRoomSend | null
  sending: boolean
  focusSignal: number
  onSend: (text: string) => Promise<boolean>
  onStop: () => Promise<void> | void
  onRefresh: () => void
  onOpenMobile: () => void
  onOpenBot: (slug: string) => void
  onReplay?: () => void
}

const DRAFTS_KEY = 'hermesbot-room-drafts'

function readDraft(roomId: string) {
  try {
    const drafts = JSON.parse(localStorage.getItem(DRAFTS_KEY) || '{}') as Record<string, unknown>
    const value = drafts[roomId]
    return typeof value === 'string' ? value.slice(0, 50_000) : ''
  } catch { return '' }
}

function writeDraft(roomId: string, value: string) {
  try {
    const drafts = JSON.parse(localStorage.getItem(DRAFTS_KEY) || '{}') as Record<string, unknown>
    if (value) drafts[roomId] = value.slice(0, 50_000)
    else delete drafts[roomId]
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts))
  } catch { /* A full or private store never blocks sending. */ }
}

function fallbackBot(member: RoomMember): Bot {
  return {
    slug: member.profile || member.member_id,
    name: member.display_name || member.handle || member.member_id,
    role: '', section: '', sectionId: '', model: '', status: 'idle', preview: '', timestamp: null, unread: 0, hidden: false,
  }
}

/** One hosted room: durable member messages, live member chips and a native everyone/mentioned composer. */
export function RoomView(props: RoomViewProps) {
  const { t } = useTranslation()
  const { room, bots, driver } = props
  const [draft, setDraft] = useState(() => props.pending?.text || readDraft(room.room_id))
  const [caret, setCaret] = useState(0)
  const [menuClosed, setMenuClosed] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [showJump, setShowJump] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const roomBots = useMemo(() => room.members.map((member) => bots.find((bot) => bot.slug === (member.profile || member.member_id)) || fallbackBot(member)), [room.members, bots])
  const activities = useMemo(() => driver?.member_activity || [], [driver])
  const activityByMember = useMemo(() => new Map(activities.map((activity) => [activity.member_id, activity])), [activities])
  const liveBots = useMemo(() => room.members.map((member, index) => {
    const activity = activityByMember.get(member.member_id)
    const base = roomBots[index]
    return activity ? { ...base, status: activity.status === 'queued' ? 'thinking' as const : 'working' as const } : { ...base, status: 'idle' as const }
  }), [room.members, roomBots, activityByMember])
  const items = useMemo(() => roomTimeline(props.events), [props.events])
  const mentionValue = useMemo<MentionContextValue>(() => ({
    index: mentionIndex(roomBots),
    bots: new Map(roomBots.map((bot) => [bot.slug, { ...bot, status: 'idle' as const }])),
    onOpenBot: props.onOpenBot,
  }), [roomBots, props.onOpenBot])
  const token = menuClosed ? null : mentionTokenAt(draft, caret)
  const options = token ? mentionOptions(token.query, roomBots, '', 6) : []
  const addressed = resolveMentions(draft, roomBots, '')
  const targetLabel = addressed.length ? t('room.only', { names: addressed.map((bot) => bot.name).join(', ') }) : t('room.everyone')
  const working = Boolean(driver?.working || activities.length)
  const locked = Boolean(props.pending) || props.sending

  useLayoutEffect(() => {
    const next = props.pending?.text || readDraft(room.room_id)
    setDraft(next)
    setCaret(next.length)
    setMenuClosed(false)
    stickRef.current = true
    setShowJump(false)
  }, [room.room_id])

  useEffect(() => {
    if (props.pending) setDraft(props.pending.text)
  }, [props.pending])

  useEffect(() => {
    if (!locked && !props.loading) textareaRef.current?.focus()
  }, [room.room_id, props.focusSignal, locked, props.loading])

  useEffect(() => {
    if (stickRef.current) endRef.current?.scrollIntoView({ block: 'end', behavior: 'instant' })
  }, [items.length, activities.length, props.loading])

  const updateDraft = (value: string, position: number) => {
    setDraft(value)
    setCaret(position)
    setMenuClosed(false)
    writeDraft(room.room_id, value)
  }

  const chooseMention = (option: { bot: Bot; tag: string }) => {
    if (!token) return
    const insert = `@${option.tag} `
    const next = `${draft.slice(0, token.start)}${insert}${draft.slice(caret)}`
    const position = token.start + insert.length
    updateDraft(next, position)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(position, position)
    })
  }

  const submit = async () => {
    const content = (props.pending?.text || draft).trim()
    if (!content || props.sending) return
    const sent = await props.onSend(content)
    if (sent) {
      setDraft('')
      setCaret(0)
      writeDraft(room.room_id, '')
      requestAnimationFrame(() => textareaRef.current?.focus())
    }
  }

  const onComposerKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape' && token) {
      event.preventDefault()
      setMenuClosed(true)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      if (token && options.length) chooseMention(options[0])
      else void submit()
    }
  }

  const stop = async () => {
    if (stopping) return
    setStopping(true)
    try { await props.onStop() } finally { setStopping(false) }
  }

  const memberName = (memberId: string) => room.members.find((member) => member.member_id === memberId)?.display_name || memberId
  const activityText = (activity: RoomMemberActivity) => {
    const status = activity.tool ? toolLabel(activity.tool) : t(`room.activity.${activity.status}`)
    return activity.round_index !== undefined && activity.round_index !== null
      ? `${status} · ${t('room.round', { number: activity.round_index + 1 })}`
      : status
  }

  return (
    <main className="chat-panel room-panel" data-room-id={room.room_id}>
      <header className="chat-header room-header">
        <div className="chat-leading"><button className="plain-icon mobile-menu" aria-label={t('room.showBots')} onClick={props.onOpenMobile}><Menu size={19} /></button></div>
        <div className="room-identity">
          <span className="room-avatar-stack" aria-hidden="true">{liveBots.slice(0, 3).map((bot) => <LiveAvatar key={bot.slug} bot={bot} size={25} />)}</span>
          <div>
            <h1>{room.name}</h1>
            <p className="room-subtitle">{t('room.memberCount', { count: room.members.length })} · {working ? t('room.talking', { count: activities.length }) : t('room.ready')}</p>
          </div>
        </div>
        <div className="chat-header-actions">
          {props.onReplay && <button className="plain-icon" aria-label={t('room.replay')} title={t('room.replay')} onClick={props.onReplay}><RotateCcw size={17} /></button>}
          {(working || props.sending || props.pending) && <button className="plain-icon room-stop" aria-label={t('room.stop')} title={t('room.stop')} disabled={stopping} onClick={() => void stop()}><Pause size={17} fill="currentColor" /></button>}
          <button className="plain-icon" aria-label={t('room.refresh')} title={t('room.refresh')} onClick={props.onRefresh}><RotateCw size={17} /></button>
        </div>
      </header>

      <div className="room-member-strip" aria-label={t('room.members')}>
        {liveBots.map((bot, index) => {
          const activity = activities.find((item) => item.member_id === room.members[index].member_id)
          return (
            <button className={`room-member-chip ${activity ? 'is-active' : ''}`} key={bot.slug} onClick={() => props.onOpenBot(bot.slug)} title={activity ? activityText(activity) : bot.role}>
              <LiveAvatar bot={bot} size={25} />
              <span>{bot.name}</span>
              {activity && <span className="room-member-activity">{activityText(activity)}</span>}
            </button>
          )
        })}
      </div>

      <div className="messages-viewport">
        <div
          className="messages-scroll room-scroll"
          ref={scrollRef}
          onWheel={(event) => { if (event.deltaY < 0) { stickRef.current = false; setShowJump(true) } }}
          onScroll={() => {
            const element = scrollRef.current
            if (element && element.scrollHeight - element.scrollTop - element.clientHeight < 80) {
              stickRef.current = true
              setShowJump(false)
            }
          }}
        >
          <MentionContext.Provider value={mentionValue}>
            <div className="messages-column room-messages-column">
              {props.loading && <div className="chat-loading" role="status"><span className="typing-dots"><i /><i /><i /></span><span>{t('room.loading')}</span></div>}
              {!props.loading && items.length === 0 && (
                <div className="chat-empty room-empty">
                  <span className="room-empty-icon"><UsersRound size={32} /></span>
                  <h2>{t('room.emptyTitle')}</h2>
                  <p>{t('room.emptyText', { count: room.members.length })}</p>
                </div>
              )}
              {!props.loading && items.map((item, index) => {
                const previous = items[index - 1]
                const day = messageDay(item.createdAt)
                const showDay = day && day !== messageDay(previous?.createdAt || null)
                if (item.kind === 'notice') return (
                  <div key={item.id}>
                    {showDay && <div className="day-separator">{day}</div>}
                    <div className={`room-notice is-${item.notice}`}><span>{t(`room.notices.${item.notice}`)}</span>{item.text && item.notice === 'failed' && <span title={item.text}>{item.text}</span>}</div>
                  </div>
                )
                if (item.kind === 'user') return (
                  <div key={item.id}>
                    {showDay && <div className="day-separator">{day}</div>}
                    <div className="room-user-message">
                      <div className="room-user-meta">{t('room.you')} · {shortTime(item.createdAt)}</div>
                      <div className="message-content">{item.text}</div>
                    </div>
                  </div>
                )
                const memberIndex = room.members.findIndex((member) => member.member_id === item.memberId)
                const bot = memberIndex >= 0 ? roomBots[memberIndex] : bots.find((itemBot) => itemBot.slug === item.memberId) || fallbackBot({ member_id: item.memberId, profile: item.memberId, handle: item.memberId })
                return (
                  <div key={item.id}>
                    {showDay && <div className="day-separator">{day}</div>}
                    <article className="room-member-message" style={{ '--avatar-color': avatarColor(bot) } as React.CSSProperties}>
                      <BotAvatar bot={{ ...bot, status: 'idle' }} size={35} />
                      <div className="room-member-bubble">
                        <header><strong>{bot.name}</strong>{item.roundIndex !== undefined && <span>{t('room.round', { number: item.roundIndex + 1 })}</span>}<time>{shortTime(item.createdAt)}</time></header>
                        <div className="message-content"><Markdown content={item.text} profile={bot.slug} version={item.id} localMedia={false} onOpenImages={() => undefined} /></div>
                      </div>
                    </article>
                  </div>
                )
              })}
              {!props.loading && activities.map((activity) => {
                const bot = liveBots[room.members.findIndex((member) => member.member_id === activity.member_id)]
                if (!bot) return null
                return <div className="room-working-row" key={`${activity.member_id}-${activity.thread_id}`}><LiveAvatar bot={bot} size={25} /><span className="working-caption">{memberName(activity.member_id)} · {activityText(activity)}</span><span className="typing-dots"><i /><i /><i /></span></div>
              })}
              <div className="messages-end" ref={endRef} />
            </div>
          </MentionContext.Provider>
        </div>
        {showJump && <button className="jump-latest" aria-label={t('room.latest')} onClick={() => { stickRef.current = true; setShowJump(false); endRef.current?.scrollIntoView({ behavior: 'instant' }) }}><ArrowDown size={18} /></button>}
      </div>

      <div className="composer-wrap room-composer-wrap">
        {props.error && <div className="room-error" role="alert"><span>{props.error}</span><button aria-label={t('room.dismissError')} onClick={props.onRefresh}><X size={14} /></button></div>}
        {token && options.length > 0 && !locked && (
          <div className="room-mention-menu" role="listbox" aria-label={t('room.mention')}>
            {options.map((option) => <button key={option.bot.slug} role="option" aria-selected="false" onClick={() => chooseMention(option)}><BotAvatar bot={option.bot} size={25} /><span>{option.bot.name}</span><span>@{option.tag}</span></button>)}
          </div>
        )}
        <div className="room-routing" title={targetLabel}><UsersRound size={13} /><span>{targetLabel}</span></div>
        <div className="composer room-composer">
          <textarea
            ref={textareaRef}
            value={draft}
            disabled={locked || props.loading}
            rows={1}
            aria-label={t('room.messageLabel')}
            placeholder={addressed.length ? t('room.messageTarget', { names: addressed.map((bot) => bot.name).join(', ') }) : t('room.messageEveryone')}
            onChange={(event) => updateDraft(event.target.value, event.target.selectionStart)}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            onKeyDown={onComposerKey}
          />
          <button className="composer-send" aria-label={props.pending ? t('room.retry') : t('room.send')} title={props.pending ? t('room.retry') : t('room.send')} disabled={locked || !draft.trim() || props.loading} onClick={() => void submit()}>
            {props.pending ? <RotateCw size={15} /> : <ArrowUp size={16} />}
          </button>
        </div>
        {props.pending && <button className="room-pending" onClick={() => void submit()} disabled={props.sending}><RotateCw size={12} />{props.sending ? t('room.confirming') : t('room.unconfirmed')}</button>}
      </div>
    </main>
  )
}
