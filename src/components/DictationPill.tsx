import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { formatTimer, type DictationController } from '../lib/dictation'
import { barCount, quantizeLevel, stillBars, WaveSampler, WAVE_BAR_WIDTH, WAVE_GAP, WAVE_STEP_MS } from '../lib/dictation-wave'
import './DictationPill.css'

const WAVE_WIDTH = 72
const WAVE_HEIGHT = 20
const MIN_BAR = 3

/** The app's own "reduce motion" setting, or the system's. */
const motionReduced = () => document.documentElement.dataset.motion === 'reduce' || Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)

function roundedBar(context: CanvasRenderingContext2D, x: number, height: number) {
  const y = (WAVE_HEIGHT - height) / 2
  context.beginPath()
  context.roundRect(x, y, WAVE_BAR_WIDTH, height, WAVE_BAR_WIDTH / 2)
  context.fill()
}

/** Bars that follow the level and slide left; dots at silence. With reduced motion: a fixed shape, four heights. */
function DictationWave({ controller }: { controller: DictationController }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    const ratio = window.devicePixelRatio || 1
    canvas.width = WAVE_WIDTH * ratio
    canvas.height = WAVE_HEIGHT * ratio
    const sampler = new WaveSampler()
    const count = barCount(WAVE_WIDTH)
    let lastStep = -1
    const draw = () => {
      const reduced = motionReduced()
      const step = quantizeLevel(controller.level)
      // Still wave: it only changes with the step, so nothing is redrawn (or cleared) in between.
      if (reduced && step === lastStep) return
      lastStep = reduced ? step : -1
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, WAVE_WIDTH, WAVE_HEIGHT)
      context.fillStyle = getComputedStyle(canvas).color
      const free = WAVE_HEIGHT - MIN_BAR
      const heights = reduced ? stillBars(step, count) : (sampler.push(controller.level), sampler.recent(count))
      heights.forEach((fraction, index) => roundedBar(context, index * (WAVE_BAR_WIDTH + WAVE_GAP), MIN_BAR + free * fraction))
    }
    draw()
    const timer = window.setInterval(draw, WAVE_STEP_MS)
    return () => window.clearInterval(timer)
  }, [controller])
  return <canvas ref={canvasRef} className="dictation-wave" style={{ width: WAVE_WIDTH, height: WAVE_HEIGHT }} aria-hidden="true" data-testid="dictation-wave" />
}

/**
 * The dictation pill of the composer: stop square, timer from 0:00 (it starts when the microphone starts
 * listening) and the wave. Shown while the dictation is starting, listening or finishing.
 */
export function DictationPill({ controller, onStop }: { controller: DictationController; onStop: () => void }) {
  const { t } = useTranslation()
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const since = snapshot.listeningSince
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (since === null) { setElapsed(0); return }
    const tick = () => setElapsed(Date.now() - since)
    tick()
    const timer = window.setInterval(tick, 250)
    return () => window.clearInterval(timer)
  }, [since])
  return (
    <div className={`dictation-pill ${snapshot.phase === 'finishing' ? 'is-finishing' : ''}`} role="group" aria-label={t('dictation.group')}>
      <button type="button" className="dictation-stop" aria-label={t('composer.stopDictation')} onClick={onStop}><span className="dictation-stop-square" aria-hidden="true" /></button>
      <span className="dictation-timer" role="timer">{formatTimer(elapsed)}</span>
      <DictationWave controller={controller} />
    </div>
  )
}
