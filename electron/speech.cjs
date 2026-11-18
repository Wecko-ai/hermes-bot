// Speech output (voice mode) in the desktop app: the Mac's own voices, played by the native helper
// (native/dictation, `hermesbot-dictation speak`). This module owns that process: one long-lived helper,
// started on the first utterance, arguments passed as an argv array (never through a shell), every line it
// prints checked against a whitelist before the page sees it, and killed when idle or when the app quits.
// No audio reaches the page: the helper plays it and only levels come back. The text of an utterance is
// never logged, and the helper's stderr is ignored.
// Half-duplex (the voice never runs while the microphone is open) is decided by `maySay`, called from main.cjs.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const { lineReader } = require('./dictation.cjs')

const LANGUAGE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/
const ERROR_CODE = /^error_[a-z_]+$/
const MAX_ID = 2_147_483_647
const MAX_TEXT = 4_000
const MAX_VOICE_ID = 200
const MAX_VOICE_NAME = 100
const MAX_VOICES = 300
const MAX_BANDS = 16
const VOICES_TIMEOUT_MS = 5_000
const IDLE_MS = 60_000
const KILL_GRACE_MS = 2_000
/** After a stop, utterances the helper never reports are closed by the app after this long. */
const STOP_SETTLE_MS = 1_000
const HELPER_ENV = { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }
const QUALITIES = ['default', 'enhanced', 'premium']

const validId = (value) => Number.isInteger(value) && value >= 1 && value <= MAX_ID
const clamp01 = (value) => Math.min(Math.max(value, 0), 1)

/** The voice may speak only while neither the microphone nor a dictation session is open. */
function maySay({ microphoneOpen, dictationActive }) {
  return !microphoneOpen && !dictationActive
}

/** One line of the helper, as the event the page may receive (or `ready`), or null for anything else. */
function parseEvent(line) {
  let value
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  switch (value.type) {
    case 'ready':
      return { type: 'ready' }
    case 'start':
      return validId(value.id) ? { type: 'start', id: value.id } : null
    case 'level': {
      if (!validId(value.id) || typeof value.rms !== 'number' || !Number.isFinite(value.rms)) return null
      if (!Array.isArray(value.bands) || value.bands.length > MAX_BANDS) return null
      if (!value.bands.every((band) => typeof band === 'number' && Number.isFinite(band))) return null
      return { type: 'level', id: value.id, rms: clamp01(value.rms), bands: value.bands.map(clamp01) }
    }
    case 'end':
      return validId(value.id) && typeof value.interrupted === 'boolean' ? { type: 'end', id: value.id, interrupted: value.interrupted } : null
    case 'error': {
      if (typeof value.code !== 'string' || !ERROR_CODE.test(value.code)) return null
      if (value.id === undefined) return { type: 'error', code: value.code }
      return validId(value.id) ? { type: 'error', id: value.id, code: value.code } : null
    }
    default:
      return null
  }
}

/** The utterance as the helper's `say` line, or null when it is not acceptable. */
function sayLine(utterance) {
  if (!utterance || typeof utterance !== 'object') return null
  const { id, text, voice, language, rate } = utterance
  if (!validId(id)) return null
  if (typeof text !== 'string' || text.length < 1 || text.length > MAX_TEXT) return null
  if (voice !== undefined && (typeof voice !== 'string' || voice.length < 1 || voice.length > MAX_VOICE_ID)) return null
  if (typeof language !== 'string' || !LANGUAGE.test(language)) return null
  if (rate !== undefined && (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0.5 || rate > 2)) return null
  return { op: 'say', id, text, ...(voice === undefined ? {} : { voice }), language, rate: rate ?? 1 }
}

function parseVoice(entry) {
  if (!entry || typeof entry !== 'object') return null
  const { id, name, language, quality } = entry
  if (typeof id !== 'string' || id.length < 1 || id.length > MAX_VOICE_ID) return null
  if (typeof name !== 'string' || name.length < 1 || name.length > MAX_VOICE_NAME) return null
  if (typeof language !== 'string' || !LANGUAGE.test(language)) return null
  if (!QUALITIES.includes(quality)) return null
  return { id, name, language, quality }
}

function parseVoices(line) {
  let value
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || !Array.isArray(value.voices)) return null
  return value.voices.slice(0, MAX_VOICES).map(parseVoice).filter(Boolean)
}

/**
 * The speech engine of the main process.
 * - helperPath: the helper binary; absent → `say` answers false and `voices` answers [].
 * - onEvent(event): delivers a checked event to the page.
 */
function createSpeech({ helperPath, onEvent, spawnImpl = spawn, exists = (file) => fs.existsSync(file) }) {
  let child = null
  const pending = new Set()
  let idleTimer = null
  let settleTimer = null

  const available = () => Boolean(helperPath) && exists(helperPath)
  const emit = (event) => { try { onEvent(event) } catch { /* the page is gone */ } }

  function terminate(target) {
    try { target.stdin.end() } catch { /* already closed */ }
    try { target.kill('SIGTERM') } catch { /* already gone */ }
    const timer = setTimeout(() => { try { target.kill('SIGKILL') } catch { /* gone */ } }, KILL_GRACE_MS)
    timer.unref?.()
    target.once?.('close', () => clearTimeout(timer))
  }

  function armIdle() {
    clearTimeout(idleTimer)
    idleTimer = null
    if (!child || pending.size > 0) return
    idleTimer = setTimeout(() => {
      idleTimer = null
      if (child && pending.size === 0) {
        const current = child
        child = null
        terminate(current)
      }
    }, IDLE_MS)
    idleTimer.unref?.()
  }

  function finish(id) {
    if (!pending.delete(id)) return false
    if (pending.size === 0) {
      clearTimeout(settleTimer)
      settleTimer = null
      armIdle()
    }
    return true
  }

  function spawnHelper() {
    let current
    try {
      current = spawnImpl(helperPath, ['speak'], { stdio: ['pipe', 'pipe', 'ignore'], env: HELPER_ENV })
    } catch {
      return null
    }
    child = current
    const lost = () => {
      if (child !== current) return
      child = null
      clearTimeout(idleTimer)
      clearTimeout(settleTimer)
      idleTimer = settleTimer = null
      const ids = [...pending]
      pending.clear()
      for (const id of ids) emit({ type: 'error', id, code: 'error_helper_exited' })
    }
    current.stdout.setEncoding('utf8')
    current.stdout.on('data', lineReader((line) => {
      if (child !== current) return
      const event = parseEvent(line)
      if (!event || event.type === 'ready') return
      if (event.type === 'error' && event.id === undefined) {
        emit(event)
        return
      }
      // Only utterances this app accepted: anything else the helper says is dropped.
      if (!pending.has(event.id)) return
      if (event.type === 'end' || event.type === 'error') finish(event.id)
      emit(event)
    }))
    current.stdin.on('error', () => {})
    current.on('error', lost)
    current.on('close', lost)
    return current
  }

  /** Queues an utterance. True when the helper accepted the line. */
  function say(utterance) {
    const line = sayLine(utterance)
    if (!line || !available() || pending.has(line.id)) return false
    const target = child ?? spawnHelper()
    if (!target || !target.stdin.writable) return false
    clearTimeout(idleTimer)
    idleTimer = null
    try {
      target.stdin.write(`${JSON.stringify(line)}\n`)
    } catch {
      return false
    }
    pending.add(line.id)
    return true
  }

  /** Stops the voice and drops the queue. Utterances the helper does not close itself are closed here. */
  function stop() {
    if (!child) return
    try { if (child.stdin.writable) child.stdin.write('{"op":"stop"}\n') } catch { /* helper gone */ }
    if (pending.size === 0) return
    clearTimeout(settleTimer)
    settleTimer = setTimeout(() => {
      settleTimer = null
      for (const id of [...pending]) {
        finish(id)
        emit({ type: 'end', id, interrupted: true })
      }
    }, STOP_SETTLE_MS)
    settleTimer.unref?.()
  }

  const isSpeaking = () => pending.size > 0

  /** The voices installed on this Mac, checked; [] on any failure. */
  function voices() {
    if (!available()) return Promise.resolve([])
    return new Promise((resolve) => {
      let probe
      try {
        probe = spawnImpl(helperPath, ['voices'], { stdio: ['ignore', 'pipe', 'ignore'], env: HELPER_ENV })
      } catch {
        resolve([])
        return
      }
      let answer = null
      const timer = setTimeout(() => { try { probe.kill('SIGKILL') } catch { /* gone */ } }, VOICES_TIMEOUT_MS)
      probe.stdout.setEncoding('utf8')
      probe.stdout.on('data', lineReader((line) => { answer ??= parseVoices(line) }))
      const done = () => { clearTimeout(timer); resolve(answer ?? []) }
      probe.on('error', done)
      probe.on('close', (code) => { clearTimeout(timer); resolve(code === 0 && answer ? answer : []) })
    })
  }

  /** The app quits or the window is gone: nothing more is said, nothing is reported. */
  function dispose() {
    clearTimeout(idleTimer)
    clearTimeout(settleTimer)
    idleTimer = settleTimer = null
    pending.clear()
    if (!child) return
    const current = child
    child = null
    terminate(current)
  }

  return { say, stop, voices, isSpeaking, dispose }
}

module.exports = { createSpeech, maySay, parseEvent, sayLine, parseVoices }
