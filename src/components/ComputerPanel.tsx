import { useCallback, useEffect, useRef, useState } from 'react'
import { Maximize2, Minimize2, Monitor } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ViewEmpty } from './ViewEmpty'
import type { Bot } from '../types'
import {
  loadComputerPages,
  loadRemoteMac,
  selectComputerPage,
  setRemoteMacControl,
  sendComputerInput,
  setComputerTakeover,
  subscribeComputerPanel,
  type ComputerPanelMeta,
  type ComputerPanelPages,
  type RemoteMac,
} from '../lib/computer-panel'
import { cdpKeyModifiers } from '../lib/cdp-modifiers'

interface ComputerPanelProps {
  bot: Bot
  onSteer?: (text: string) => Promise<void>
}

const emptyMeta: ComputerPanelMeta = { state: 'idle', url: '', title: '', driver: '', userControlled: false }

/** A Mac the bot drives over SSH (remote-cua): take over / hand back. Hidden for a bot without one. */
function RemoteMacSection({ bot, onSteer }: ComputerPanelProps) {
  const { t } = useTranslation()
  const [remote, setRemote] = useState<RemoteMac | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let stopped = false
    setRemote(null)
    const read = () => loadRemoteMac(bot.slug).then((next) => { if (!stopped) setRemote(next) }).catch(() => undefined)
    void read()
    const timer = window.setInterval(read, 5_000)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [bot.slug])
  if (!remote?.configured || !remote.machine) return null
  const human = remote.lease.holder === 'human'
  const other = human && !remote.mine
  const change = async (active: boolean) => {
    setBusy(true)
    setError('')
    try {
      const next = await setRemoteMacControl(bot.slug, active, !active && other ? { epoch: remote.lease.epoch } : undefined)
      setRemote(next)
      if (next.error) setError(t(`computerPanel.remote.errors.${next.error}`, { defaultValue: t('computerPanel.remote.errors.other') }))
      else if (onSteer && next.steerText) await onSteer(next.steerText).catch(() => undefined)
    } catch {
      setError(t('computerPanel.remote.errors.other'))
    } finally {
      setBusy(false)
    }
  }
  const state = other ? t('computerPanel.remote.heldElsewhere') : human ? t('computerPanel.remote.youHave') : t('computerPanel.remote.botHas')
  return (
    <section className="details-section computer-remote" aria-label={t('computerPanel.remote.heading')}>
      <div className="details-section-heading"><span>{t('computerPanel.remote.heading')}</span></div>
      <p className="computer-remote-machine">{remote.machine.user}@{remote.machine.host}</p>
      <p className={`computer-remote-state${human ? ' is-human' : ''}`} role="status">{state}</p>
      {error && <p className="computer-remote-error" role="alert">{error}</p>}
      <div className="computer-panel-actions">
        <button type="button" className={human ? 'secondary' : 'primary'} disabled={busy} onClick={() => void change(!human)}>
          {other ? t('computerPanel.remote.forceBack') : human ? t('computerPanel.giveBack') : t('computerPanel.takeOver')}
        </button>
      </div>
      <p className="readonly-note">{t('computerPanel.remote.hint')}</p>
    </section>
  )
}

export function ComputerPanel(props: ComputerPanelProps) {
  return (
    <>
      <ChromePanel {...props} />
      <RemoteMacSection {...props} />
    </>
  )
}

function ChromePanel({ bot, onSteer }: ComputerPanelProps) {
  const { t } = useTranslation()
  const [meta, setMeta] = useState<ComputerPanelMeta>(emptyMeta)
  const [frame, setFrame] = useState('')
  const [busy, setBusy] = useState(false)
  const viewRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef('')
  const [pages, setPages] = useState<ComputerPanelPages>({ team: '', following: true, pages: [] })
  const [expanded, setExpanded] = useState(false)
  // Closing the panel (or switching bot) while in control hands the browser back to the bot.
  const controlRef = useRef({ slug: bot.slug, controlled: false, onSteer })
  controlRef.current = { slug: bot.slug, controlled: meta.userControlled, onSteer }
  useEffect(() => () => {
    const { slug, controlled, onSteer: steer } = controlRef.current
    if (!controlled) return
    void setComputerTakeover(slug, false).then((result) => (steer && result.steerText ? steer(result.steerText) : undefined)).catch(() => undefined)
  }, [bot.slug])

  // The team Chrome's tabs, refreshed while the view is live.
  const live = meta.state === 'live'
  useEffect(() => {
    let stopped = false
    const read = () => loadComputerPages(bot.slug).then((next) => { if (!stopped) setPages(next) }).catch(() => undefined)
    void read()
    if (!live) return () => { stopped = true }
    const timer = window.setInterval(read, 5_000)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [bot.slug, live])
  const pickPage = async (targetId: string) => {
    setFrame('')
    frameRef.current = ''
    const next = await selectComputerPage(bot.slug, targetId).catch(() => null)
    if (next) setPages(next)
  }

  useEffect(() => {
    if (!expanded) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !meta.userControlled) setExpanded(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded, meta.userControlled])

  useEffect(() => {
    setMeta(emptyMeta)
    setFrame('')
    frameRef.current = ''
    const stop = subscribeComputerPanel(bot.slug, {
      onMeta: setMeta,
      onFrame: (jpeg) => {
        frameRef.current = jpeg
        setFrame(jpeg)
      },
    })
    return stop
  }, [bot.slug])

  const toggleTakeover = useCallback(async () => {
    setBusy(true)
    try {
      const next = !meta.userControlled
      const result = await setComputerTakeover(bot.slug, next)
      if (onSteer && result.steerText) await onSteer(result.steerText).catch(() => undefined)
      setMeta((current) => ({ ...current, userControlled: result.userControlled }))
    } finally {
      setBusy(false)
    }
  }, [bot.slug, meta.userControlled, onSteer])

  const pointFromEvent = (clientX: number, clientY: number) => {
    const box = viewRef.current?.getBoundingClientRect()
    if (!box?.width || !box.height) return null
    const img = viewRef.current?.querySelector('img')
    const width = img?.clientWidth || box.width
    const height = img?.clientHeight || box.height
    const offsetX = box.left + (box.width - width) / 2
    const offsetY = box.top + (box.height - height) / 2
    const x = ((clientX - offsetX) / width) * (img?.naturalWidth || width)
    const y = ((clientY - offsetY) / height) * (img?.naturalHeight || height)
    return {
      x: Math.round(Math.max(0, x)),
      y: Math.round(Math.max(0, y)),
    }
  }

  const onPointer = (type: 'mousePressed' | 'mouseReleased', event: React.MouseEvent) => {
    if (!meta.userControlled) return
    const point = pointFromEvent(event.clientX, event.clientY)
    if (!point) return
    void sendComputerInput(bot.slug, { kind: 'mouse', type, ...point, button: 'left', clickCount: 1 }).catch(() => undefined)
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!meta.userControlled) return
    event.preventDefault()
    void sendComputerInput(bot.slug, {
      kind: 'key',
      type: 'keyDown',
      key: event.key,
      text: event.key.length === 1 ? event.key : '',
      code: event.code,
      modifiers: cdpKeyModifiers(event),
    }).catch(() => undefined)
  }

  const onWheel = (event: React.WheelEvent) => {
    if (!meta.userControlled) return
    event.preventDefault()
    const point = pointFromEvent(event.clientX, event.clientY)
    if (!point) return
    void sendComputerInput(bot.slug, {
      kind: 'wheel',
      ...point,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
    }).catch(() => undefined)
  }

  const driverLabel = meta.driver
    ? t('computerPanel.driving', { name: meta.driver })
    : t('computerPanel.noDriver')

  return (
    <section className={`details-section computer-panel${expanded ? ' is-expanded' : ''}`} aria-label={t('computerPanel.heading')}>
      <div className="details-section-heading computer-panel-heading">
        <span>{pages.team ? t('computerPanel.headingTeam', { team: pages.team }) : t('computerPanel.heading')}</span>
        <button type="button" className="plain-icon" aria-label={expanded ? t('computerPanel.collapse') : t('computerPanel.expand')} title={expanded ? t('computerPanel.collapse') : t('computerPanel.expand')} onClick={() => setExpanded(!expanded)}>
          {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
      </div>
      {meta.userControlled && <p className="computer-panel-banner" role="status">{t('computerPanel.userControlBanner')}</p>}
      <div
        className={`computer-panel-view ${meta.userControlled ? 'is-controlled' : ''} ${meta.state === 'live' ? 'is-live' : 'is-idle'}`}
        ref={viewRef}
        tabIndex={meta.userControlled ? 0 : -1}
        onKeyDown={onKeyDown}
        onMouseDown={(event) => onPointer('mousePressed', event)}
        onMouseUp={(event) => onPointer('mouseReleased', event)}
        onWheel={onWheel}
        aria-label={t('computerPanel.viewAria')}
      >
        {frame
          ? <img src={`data:image/jpeg;base64,${frame}`} alt="" draggable={false} />
          : (
            <ViewEmpty
              variant="panel"
              icon={<Monitor size={22} strokeWidth={1.75} />}
              title={meta.state === 'idle' ? t('computerPanel.idle') : t('computerPanel.waiting')}
            />
          )}
      </div>
      {pages.pages.length > 1 && (
        <label className="computer-panel-tabs">
          <span>{t('computerPanel.tab')}</span>
          <select value={pages.following ? '' : (pages.pages.find((page) => page.current)?.id ?? '')} onChange={(event) => void pickPage(event.target.value)}>
            <option value="">{t('computerPanel.followBot')}</option>
            {pages.pages.map((page) => <option key={page.id} value={page.id}>{page.title || page.url || page.id}</option>)}
          </select>
        </label>
      )}
      <div className="computer-panel-meta">
        <p className="computer-panel-title" title={meta.title}>{meta.title || '—'}</p>
        <p className="computer-panel-url" title={meta.url}>{meta.url || '—'}</p>
        <p className="computer-panel-driver">{driverLabel}</p>
      </div>
      <div className="computer-panel-actions">
        <button
          type="button"
          className={meta.userControlled ? 'secondary' : 'primary'}
          disabled={busy || meta.state !== 'live'}
          onClick={() => void toggleTakeover()}
        >
          {meta.userControlled ? t('computerPanel.giveBack') : t('computerPanel.takeOver')}
        </button>
      </div>
      <p className="readonly-note">{t('computerPanel.hint')}</p>
    </section>
  )
}