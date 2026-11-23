import { useCallback, useEffect, useRef, useState } from 'react'
import { Monitor } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ViewEmpty } from './ViewEmpty'
import type { Bot } from '../types'
import {
  sendComputerInput,
  setComputerTakeover,
  subscribeComputerPanel,
  type ComputerPanelMeta,
} from '../lib/computer-panel'
import { cdpKeyModifiers } from '../lib/cdp-modifiers'

interface ComputerPanelProps {
  bot: Bot
  onSteer?: (text: string) => Promise<void>
}

const emptyMeta: ComputerPanelMeta = { state: 'idle', url: '', title: '', driver: '', userControlled: false }

export function ComputerPanel({ bot, onSteer }: ComputerPanelProps) {
  const { t } = useTranslation()
  const [meta, setMeta] = useState<ComputerPanelMeta>(emptyMeta)
  const [frame, setFrame] = useState('')
  const [busy, setBusy] = useState(false)
  const viewRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef('')

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
    <section className="details-section computer-panel">
      <div className="details-section-heading"><span>{t('computerPanel.heading')}</span></div>
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