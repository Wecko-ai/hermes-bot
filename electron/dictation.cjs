// Dictation in the desktop app: the operating system's speech recognizer, run by a small helper process
// (native/dictation, built by scripts/build-dictation.cjs). This module owns that process: one session at a
// time, arguments checked here and passed as an argv array (never through a shell), its JSON lines turned into
// the events the page receives, and the process killed whenever the page can no longer want it.
// No audio passes through the app: the helper hands the microphone to the system's recognizer and only text
// and a level come back. Nothing the helper prints is logged: its stderr is ignored and its lines go to the page.
// Who may start a session is decided before this module is called (dictation-gate.cjs, main.cjs).
const { spawn } = require('node:child_process')
const fs = require('node:fs')

const LOCALE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/
const ERROR_CODE = /^error_[a-z_]{1,40}$/
const MAX_LINE = 64 * 1024
const MAX_TEXT = 20_000
/** Without "listening" by then, the session did not start. */
const START_TIMEOUT_MS = 3_000
/** A session never outlives its time limit by more than this. */
const SESSION_MARGIN_MS = 15_000
/** The system's prompts wait for an answer; past this, the app treats the access as refused for now. */
const AUTHORIZE_TIMEOUT_MS = 3 * 60_000
const PROBE_TIMEOUT_MS = 10_000
/** After a cancel, the helper gets this long to leave on its own before it is killed. */
const CANCEL_GRACE_MS = 500
// The helper needs nothing from the app's environment, and gets none of it.
const HELPER_ENV = { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }

const UNAVAILABLE = Object.freeze({ access: 'unavailable', microphone: false, exists: false, onDevice: false, available: false })

function validLocale(value) {
  return typeof value === 'string' && LOCALE.test(value) ? value : null
}

const clamp = (value, min, max, fallback) => (typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(Math.round(value), min), max) : fallback)

/** The helper's arguments for a session, or null when the options are not acceptable. */
function listenArguments(options) {
  if (!options || typeof options !== 'object') return null
  const locale = validLocale(options.localeId)
  if (!locale) return null
  // Two minutes at most, whatever the page asks (it asks one).
  const listenFor = clamp(options.listenForMs, 1_000, 120_000, 60_000)
  const pauseFor = clamp(options.pauseForMs, 500, 60_000, 4_500)
  return [
    'listen', '--locale', locale,
    ...(options.onDevice === true ? ['--on-device'] : []),
    '--listen-for-ms', String(listenFor),
    '--pause-for-ms', String(pauseFor),
  ]
}

/** One line of the helper, as the event the page may receive, or null for anything else. */
function parseEvent(line) {
  let value
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  switch (value.type) {
    case 'listening':
    case 'audioEnd':
    case 'done':
      return { type: value.type }
    case 'words':
      if (typeof value.text !== 'string') return null
      return { type: 'words', text: value.text.slice(0, MAX_TEXT), final: value.final === true }
    case 'level':
      if (typeof value.value !== 'number' || !Number.isFinite(value.value)) return null
      return { type: 'level', value: Math.min(Math.max(value.value, 0), 1) }
    case 'error':
      return { type: 'error', code: typeof value.code === 'string' && ERROR_CODE.test(value.code) ? value.code : 'error_listen_failed' }
    default:
      return null
  }
}

/** The helper's probe line, as `prepare` answers it. `undetermined` stays as is: the caller asks then. */
function parseProbe(line) {
  let value
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || !['granted', 'denied', 'unavailable', 'undetermined'].includes(value.access)) return null
  return {
    access: value.access,
    microphone: value.microphone === true,
    exists: value.exists === true,
    onDevice: value.onDevice === true,
    available: value.available === true,
  }
}

/** Splits a stream into lines, dropping any line longer than MAX_LINE. */
function lineReader(onLine) {
  let buffer = ''
  let skipping = false
  return (chunk) => {
    buffer += chunk
    let at
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (!skipping) onLine(line)
      skipping = false
    }
    if (buffer.length > MAX_LINE) {
      buffer = ''
      skipping = true
    }
  }
}

/**
 * The dictation engine of the main process.
 * - helperPath: the helper binary; absent → every `prepare` answers "unavailable".
 * - send(event): delivers an event to the page.
 */
function createDictation({ helperPath, send, spawnImpl = spawn, exists = (file) => fs.existsSync(file) }) {
  let session = null
  let preparing = null
  let sessionCount = 0

  const available = () => Boolean(helperPath) && exists(helperPath)

  /** Runs a short helper command and returns its first parsed probe line. */
  function runProbe(command, localeId, timeoutMs) {
    return new Promise((resolve) => {
      let child
      try {
        child = spawnImpl(helperPath, [command, '--locale', localeId], { stdio: ['ignore', 'pipe', 'ignore'], env: HELPER_ENV })
      } catch {
        resolve(null)
        return
      }
      let answer = null
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', lineReader((line) => { answer ??= parseProbe(line) }))
      child.on('error', () => { clearTimeout(timer); resolve(null) })
      child.on('close', () => { clearTimeout(timer); resolve(answer) })
    })
  }

  /** Access, microphone and language. Asks the system for the permissions the first time. */
  function prepare(localeId) {
    const locale = validLocale(localeId)
    if (!locale || !available()) return Promise.resolve({ ...UNAVAILABLE })
    preparing ??= (async () => {
      let state = await runProbe('probe', locale, PROBE_TIMEOUT_MS)
      if (!state) return { ...UNAVAILABLE }
      // Undecided: the system asks now. A prompt left unanswered past the timeout counts as refused for now;
      // the next `prepare` asks again.
      if (state.access === 'undetermined') state = (await runProbe('authorize', locale, AUTHORIZE_TIMEOUT_MS)) ?? state
      return { ...state, access: state.access === 'undetermined' ? 'denied' : state.access }
    })().finally(() => { preparing = null })
    return preparing
  }

  function end(current) {
    if (session === current) session = null
    clearTimeout(current.startTimer)
    clearTimeout(current.limitTimer)
  }

  /** Starts a session. Resolves true once the microphone runs, false otherwise (an error event says why). */
  function start(options) {
    const args = listenArguments(options)
    if (!args || !available()) return Promise.resolve(false)
    if (session) cancel()
    const listenFor = Number(args[args.indexOf('--listen-for-ms') + 1])
    return new Promise((resolve) => {
      let child
      try {
        child = spawnImpl(helperPath, args, { stdio: ['pipe', 'pipe', 'ignore'], env: HELPER_ENV })
      } catch {
        resolve(false)
        return
      }
      const current = { id: ++sessionCount, child, cancelled: false, finished: false, started: false }
      session = current
      const settle = (value) => {
        if (current.settled) return
        current.settled = true
        resolve(value)
      }
      const deliver = (event) => {
        if (current.cancelled || current.finished) return
        if (event.type === 'listening') {
          current.started = true
          clearTimeout(current.startTimer)
          settle(true)
          return
        }
        if (event.type === 'done' || event.type === 'error') {
          current.finished = true
          end(current)
          settle(false)
        }
        send(event)
      }
      current.startTimer = setTimeout(() => {
        if (current.started) return
        // No microphone after 3 s: this session did not start, and nothing more comes from it.
        current.cancelled = true
        end(current)
        settle(false)
        child.kill('SIGKILL')
      }, START_TIMEOUT_MS)
      current.limitTimer = setTimeout(() => {
        deliver({ type: 'error', code: 'error_speech_timeout' })
        child.kill('SIGKILL')
      }, listenFor + SESSION_MARGIN_MS)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', lineReader((line) => {
        const event = parseEvent(line)
        if (event) deliver(event)
      }))
      // A closed pipe after the helper left is not an error of the session.
      child.stdin.on('error', () => {})
      child.on('error', () => deliver({ type: 'error', code: 'error_listen_failed' }))
      // Gone without a last word (crash, killed from outside): the page must not wait for one.
      child.on('close', () => deliver({ type: 'error', code: 'error_listen_failed' }))
    })
  }

  /** Closes the microphone; the final result follows as events. */
  function stop() {
    const current = session
    if (current && !current.cancelled && current.child.stdin.writable) current.child.stdin.write('stop\n')
  }

  /** Abandons the session: nothing more reaches the page, and the helper is gone shortly after. */
  function cancel() {
    const current = session
    if (!current) return
    current.cancelled = true
    end(current)
    if (current.child.stdin.writable) current.child.stdin.write('cancel\n')
    const kill = setTimeout(() => current.child.kill('SIGKILL'), CANCEL_GRACE_MS)
    current.child.once('close', () => clearTimeout(kill))
  }

  return { prepare, start, stop, cancel, dispose: cancel, get active() { return Boolean(session) } }
}

module.exports = { createDictation, listenArguments, parseEvent, parseProbe, validLocale, lineReader, UNAVAILABLE }
