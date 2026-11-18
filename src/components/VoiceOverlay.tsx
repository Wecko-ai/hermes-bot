import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { Mic, Pause, VolumeX, X } from 'lucide-react'
import type { Bot } from '../types'
import type { VoiceSession } from '../lib/voice-session'
import type { PendingPrompt } from '../lib/hermes'
import { PromptCard } from './PromptCard'
import { createHudMemory, drawHud, stepHud, type HudState } from '../lib/voice-hud'
import { avatarColor } from './BotAvatar'
import { useAppConfig } from '../lib/app-config'
import { LiveAvatar, useReducedMotion } from './LiveAvatar'
import './VoiceOverlay.css'

interface VoiceOverlayProps {
  session: VoiceSession
  bot: Bot
  running: boolean
  /** The tool the bot is using, if any ("web search"). */
  activity: string
  onClose: () => void
  onStopBot: () => void
  /** A question or approval of the bot: its card stays reachable over the voice mode. */
  prompt?: PendingPrompt
  onAnswerPrompt: (prompt: PendingPrompt, answer: string) => Promise<void>
}

const FALLBACK_ACCENT = 'rgb(79, 209, 255)'
const ASKING_ACCENT = 'rgb(245, 185, 66)'
const DICTATION_NOTICES = new Set(['permission', 'unavailable', 'noMicrophone', 'language', 'offline', 'failed'])

/** The computed color of the probe, or the fallback when the bot's color is too dark for the HUD. */
function readableAccent(probe: HTMLElement | null) {
  const color = probe ? getComputedStyle(probe).color : ''
  const rgb = /rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/i.exec(color)
  if (!rgb) return FALLBACK_ACCENT
  const [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  return luminance < 0.18 ? FALLBACK_ACCENT : `rgb(${r}, ${g}, ${b})`
}

/**
 * Voice mode over the chat: the bot's avatar inside a HUD that pulses with the voice, the state, the
 * caption and the controls. Talk: hold and release (push-to-talk), or tap and pause. Enter does the same.
 */
export function VoiceOverlay({ session, bot, running, activity, onClose, onStopBot, prompt, onAnswerPrompt }: VoiceOverlayProps) {
  const { t } = useTranslation()
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const reducedMotion = useReducedMotion()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const probeRef = useRef<HTMLSpanElement>(null)
  const talkRef = useRef<HTMLButtonElement>(null)
  const phaseRef = useRef<HudState>(snapshot.phase)
  phaseRef.current = snapshot.phase
  const reducedRef = useRef(reducedMotion)
  reducedRef.current = reducedMotion
  const [notice, setNotice] = useState<string | null>(null)
  const color = avatarColor(bot)
  const modeName = useAppConfig().ui.voiceModeName || t('voice.name')

  // The HUD: one frame per display refresh while the window is visible, reading the levels directly.
  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    const memory = createHudMemory()
    let accent = readableAccent(probeRef.current)
    let frame = 0
    let size = { width: 0, height: 0, dpr: 1 }
    const resize = () => {
      const box = canvas.getBoundingClientRect()
      const dpr = Math.min(3, window.devicePixelRatio || 1)
      size = { width: box.width, height: box.height, dpr }
      canvas.width = Math.round(box.width * dpr)
      canvas.height = Math.round(box.height * dpr)
      accent = readableAccent(probeRef.current)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    resize()
    const draw = (time: number) => {
      frame = requestAnimationFrame(draw)
      if (document.hidden || !size.width) return
      const hud = {
        state: phaseRef.current,
        level: session.hudLevel,
        bands: session.hudBands,
        time,
        ...size,
        accent,
        askingAccent: ASKING_ACCENT,
        reducedMotion: reducedRef.current,
      }
      stepHud(memory, hud)
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.clearRect(0, 0, canvas.width, canvas.height)
      drawHud(context, memory, hud)
    }
    frame = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [session, color])

  // Enter: press and release like the Talk button. Escape: leave.
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey) return
      // Enter belongs to a field or another button of the card, not to Talk.
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (target?.closest('button') && target !== talkRef.current) return
      event.preventDefault()
      if (!event.repeat) session.pressTalk()
    }
    const up = (event: KeyboardEvent) => {
      if (event.key === 'Enter') session.releaseTalk()
    }
    const back = () => { if (!document.hidden) session.recheckAccess() }
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    window.addEventListener('focus', back)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
      window.removeEventListener('focus', back)
    }
  }, [session, onClose])

  useEffect(() => { talkRef.current?.focus() }, [])

  // A notice stays a few seconds.
  useEffect(() => {
    const { notice: code } = snapshot
    if (!code) return
    setNotice(DICTATION_NOTICES.has(code) ? t(`dictation.notice.${code}`) : t(`voice.notice.${code}`))
    const timer = setTimeout(() => setNotice(null), 4_500)
    return () => clearTimeout(timer)
    // The key changes at each notice, even the same one twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.noticeKey])

  const pressTalk = (event: React.PointerEvent) => {
    if (event.button !== 0) return
    session.pressTalk()
    const release = () => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
      session.releaseTalk()
    }
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
  }

  const { phase } = snapshot
  const state = phase === 'thinking' && activity
    ? t('voice.thinkingWith', { activity })
    : phase === 'asking' && snapshot.approval
      ? t('voice.approval')
      : phase === 'asking'
        ? t('voice.question')
        : t(`voice.phase.${phase}`)
  const caption = phase === 'listening'
    ? snapshot.transcript || '…'
    : phase === 'speaking'
      ? snapshot.caption
      : phase === 'idle' && !snapshot.transcript && !snapshot.caption
        ? t('voice.idleCaption', { name: bot.name })
        : phase === 'thinking' ? snapshot.transcript : snapshot.caption || snapshot.transcript

  return (
    <div
      className={`voice-overlay is-${phase}`}
      role="dialog"
      aria-modal="true"
      aria-label={modeName}
      style={{ '--voice-accent': color } as CSSProperties}
    >
      <span ref={probeRef} className="voice-accent-probe" aria-hidden="true" />
      <header className="voice-header">
        <span className="voice-title">{modeName} · {bot.name}</span>
        <button type="button" className="voice-icon-button" aria-label={t('voice.close')} title={t('voice.close')} onClick={onClose}><X size={18} /></button>
      </header>
      <div className="voice-stage">
        <canvas ref={canvasRef} className="voice-hud" aria-hidden="true" />
        <div className="voice-avatar"><LiveAvatar bot={bot} size={92} /></div>
      </div>
      <p className="voice-state" aria-live="polite">{state}</p>
      <p className={`voice-caption ${phase === 'thinking' ? 'is-quiet' : ''}`}>{caption}</p>
      <p className="voice-notice" role="status">{notice ?? ''}</p>
      {prompt && (
        <div className="voice-prompt">
          <PromptCard key={prompt.promptId} prompt={prompt} botName={bot.name} onAnswer={onAnswerPrompt} />
        </div>
      )}
      <div className="voice-controls">
        {phase === 'speaking' && (
          <button type="button" className="voice-icon-button" aria-label={t('voice.stopSpeaking')} title={t('voice.stopSpeaking')} onClick={() => session.stopSpeaking()}><VolumeX size={18} /></button>
        )}
        <button
          ref={talkRef}
          type="button"
          className={`voice-talk ${phase === 'listening' ? 'is-on' : ''}`}
          aria-pressed={phase === 'listening'}
          aria-disabled={snapshot.blocked !== null || undefined}
          title={t('voice.talkTitle')}
          onPointerDown={pressTalk}
          onClick={(event) => event.preventDefault()}
        >
          <Mic size={20} />
          <span>{t('voice.talk')}</span>
        </button>
        {running && (
          <button type="button" className="voice-icon-button" aria-label={t('voice.stopBot', { name: bot.name })} title={t('voice.stopBot', { name: bot.name })} onClick={onStopBot}><Pause size={16} fill="currentColor" /></button>
        )}
      </div>
    </div>
  )
}
