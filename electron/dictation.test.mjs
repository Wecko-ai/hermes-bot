import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import dictationModule from './dictation.cjs'

const { createDictation, listenArguments, parseEvent, parseProbe, validLocale, lineReader } = dictationModule

/** A child process stand-in: the test writes its stdout and reads what it got on stdin. */
function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stdout.setEncoding = () => {}
  child.stdin = new EventEmitter()
  child.stdin.writable = true
  child.stdin.written = []
  child.stdin.write = (text) => { child.stdin.written.push(text) }
  child.stdin.end = () => { child.stdin.writable = false }
  child.killed = []
  child.kill = (signal) => { child.killed.push(signal); child.exit() }
  child.say = (object) => child.stdout.emit('data', `${JSON.stringify(object)}\n`)
  child.exit = (code = 0) => {
    if (child.closed) return
    child.closed = true
    child.stdin.writable = false
    child.emit('close', code, null)
  }
  return child
}

function engine({ helperPresent = true } = {}) {
  const children = []
  const calls = []
  const events = []
  const microphone = []
  const dictation = createDictation({
    helperPath: '/helper',
    send: (event) => events.push(event),
    onMicrophone: (open) => microphone.push(open),
    exists: () => helperPresent,
    spawnImpl: (file, args, options) => {
      calls.push({ file, args, options })
      const child = fakeChild()
      children.push(child)
      return child
    },
  })
  return { dictation, children, calls, events, microphone }
}

describe('dictation arguments', () => {
  it('accepts a language tag, nothing else', () => {
    expect(validLocale('fr-FR')).toBe('fr-FR')
    expect(validLocale('en-US')).toBe('en-US')
    expect(validLocale('yue-CN')).toBe('yue-CN')
    for (const bad of ['', 'FR', 'fr_FR', 'fr-FR;rm -rf', '--locale', 'fr-FR\n', 42, undefined]) expect(validLocale(bad), String(bad)).toBeNull()
  })

  it('builds the argv array, numbers clamped', () => {
    expect(listenArguments({ localeId: 'fr-FR', onDevice: true, listenForMs: 60_000, pauseForMs: 4_500 }))
      .toEqual(['listen', '--locale', 'fr-FR', '--on-device', '--listen-for-ms', '60000', '--pause-for-ms', '4500'])
    expect(listenArguments({ localeId: 'en-US', onDevice: 'yes', listenForMs: 1e9, pauseForMs: -5 }))
      .toEqual(['listen', '--locale', 'en-US', '--listen-for-ms', '120000', '--pause-for-ms', '500'])
    expect(listenArguments({ localeId: 'en-US', listenForMs: Number.NaN })).toContain('60000')
    // Client mode allows one minute.
    expect(listenArguments({ localeId: 'en-US', listenForMs: 120_000 }, 60_000)).toContain('60000')
    expect(listenArguments({ localeId: 'en-US', listenForMs: 30_000 }, 60_000)).toContain('30000')
    expect(listenArguments({ localeId: 'fr FR' })).toBeNull()
    expect(listenArguments(null)).toBeNull()
  })
})

describe('helper lines', () => {
  it('keeps the known events, cleaned', () => {
    expect(parseEvent('{"type":"words","text":"Bonjour","final":false}')).toEqual({ type: 'words', text: 'Bonjour', final: false })
    expect(parseEvent('{"type":"words","text":"Fini.","final":true,"extra":1}')).toEqual({ type: 'words', text: 'Fini.', final: true })
    expect(parseEvent('{"type":"level","value":1.7}')).toEqual({ type: 'level', value: 1 })
    expect(parseEvent('{"type":"level","value":-0.2}')).toEqual({ type: 'level', value: 0 })
    expect(parseEvent('{"type":"audioEnd"}')).toEqual({ type: 'audioEnd' })
    expect(parseEvent('{"type":"error","code":"error_network"}')).toEqual({ type: 'error', code: 'error_network' })
    expect(parseEvent('{"type":"error","code":"<script>"}')).toEqual({ type: 'error', code: 'error_listen_failed' })
  })

  it('drops the rest', () => {
    for (const line of ['', 'not json', '42', 'null', '{"type":"words"}', '{"type":"level","value":"x"}', '{"type":"shell"}']) expect(parseEvent(line), line).toBeNull()
  })

  it('reads the probe line', () => {
    expect(parseProbe('{"access":"granted","microphone":true,"exists":true,"onDevice":true,"available":true}'))
      .toEqual({ access: 'granted', microphone: true, exists: true, onDevice: true, available: true })
    expect(parseProbe('{"access":"maybe"}')).toBeNull()
  })

  it('splits chunks into lines and drops an endless one', () => {
    const lines = []
    const read = lineReader((line) => lines.push(line))
    read('{"a":')
    read('1}\n{"b":2}\n{"c"')
    read(':3}\n')
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}'])
    read('x'.repeat(70 * 1024))
    read('tail\nnext\n')
    expect(lines.slice(3)).toEqual(['next'])
  })
})

describe('dictation engine', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('answers unavailable without the helper, or for a bad language', async () => {
    const { dictation, calls } = engine({ helperPresent: false })
    expect((await dictation.prepare('fr-FR')).access).toBe('unavailable')
    expect(await dictation.start({ localeId: 'fr-FR' })).toBe(false)
    expect(calls).toHaveLength(0)
    const other = engine()
    expect((await other.dictation.prepare('fr FR')).access).toBe('unavailable')
    expect(other.calls).toHaveLength(0)
  })

  it('probes, then asks the system only when nothing is decided', async () => {
    const { dictation, children, calls } = engine()
    const answer = dictation.prepare('fr-FR')
    children[0].say({ access: 'undetermined', microphone: true, exists: true, onDevice: true, available: true })
    children[0].exit()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls[1].args).toEqual(['authorize', '--locale', 'fr-FR'])
    children[1].say({ access: 'granted', microphone: true, exists: true, onDevice: true, available: true })
    children[1].exit()
    expect(await answer).toEqual({ access: 'granted', microphone: true, exists: true, onDevice: true, available: true })
    expect(calls[0].options.env).toEqual({ PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' })
  })

  it('treats a prompt left unanswered as refused for now', async () => {
    const { dictation, children } = engine()
    const answer = dictation.prepare('en-US')
    children[0].say({ access: 'undetermined', microphone: true, exists: true, onDevice: false, available: true })
    children[0].exit()
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    expect(children[1].killed).toEqual(['SIGKILL'])
    expect(await answer).toEqual({ access: 'denied', microphone: true, exists: true, onDevice: false, available: true })
  })

  it('runs a session: listening, words, level, final, done', async () => {
    const { dictation, children, calls, events } = engine()
    const started = dictation.start({ localeId: 'fr-FR', onDevice: true, listenForMs: 60_000, pauseForMs: 4_500 })
    const child = children[0]
    expect(calls[0].args[0]).toBe('listen')
    child.say({ type: 'listening' })
    expect(await started).toBe(true)
    child.say({ type: 'words', text: 'Bonjour', final: false })
    child.say({ type: 'level', value: 0.4 })
    dictation.stop()
    expect(child.stdin.written).toEqual(['stop\n'])
    child.say({ type: 'audioEnd' })
    child.say({ type: 'words', text: 'Bonjour.', final: true })
    child.say({ type: 'done' })
    child.exit()
    expect(events).toEqual([
      { type: 'words', text: 'Bonjour', final: false },
      { type: 'level', value: 0.4 },
      { type: 'audioEnd' },
      { type: 'words', text: 'Bonjour.', final: true },
      { type: 'done' },
    ])
    expect(dictation.active).toBe(false)
  })

  it('gives up after 3 s without the microphone', async () => {
    const { dictation, children, events } = engine()
    const started = dictation.start({ localeId: 'fr-FR' })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(await started).toBe(false)
    expect(children[0].killed).toEqual(['SIGKILL'])
    expect(events).toEqual([])
  })

  it('reports an error before the start, and resolves false', async () => {
    const { dictation, children, events } = engine()
    const started = dictation.start({ localeId: 'fr-FR' })
    children[0].say({ type: 'error', code: 'error_permission' })
    children[0].exit(1)
    expect(await started).toBe(false)
    expect(events).toEqual([{ type: 'error', code: 'error_permission' }])
  })

  it('cancel: nothing more reaches the page, the helper is killed if it lingers', async () => {
    const { dictation, children, events } = engine()
    const started = dictation.start({ localeId: 'fr-FR' })
    const child = children[0]
    child.say({ type: 'listening' })
    await started
    child.closed = false
    child.kill = (signal) => { child.killed.push(signal) }
    dictation.cancel()
    expect(child.stdin.written).toEqual(['cancel\n'])
    child.say({ type: 'words', text: 'trop tard', final: true })
    await vi.advanceTimersByTimeAsync(500)
    expect(child.killed).toEqual(['SIGKILL'])
    expect(events).toEqual([])
  })

  it('a helper gone without a last word ends the session with an error', async () => {
    const { dictation, children, events } = engine()
    const started = dictation.start({ localeId: 'fr-FR' })
    children[0].say({ type: 'listening' })
    await started
    children[0].exit(9)
    expect(events).toEqual([{ type: 'error', code: 'error_listen_failed' }])
  })

  it('never outlives its time limit', async () => {
    const { dictation, children, events } = engine()
    const started = dictation.start({ localeId: 'fr-FR', listenForMs: 5_000 })
    children[0].say({ type: 'listening' })
    await started
    await vi.advanceTimersByTimeAsync(5_000 + 15_000)
    expect(events).toEqual([{ type: 'error', code: 'error_speech_timeout' }])
    expect(children[0].killed).toEqual(['SIGKILL'])
  })

  it('one session at a time: a new start cancels the previous one', async () => {
    const { dictation, children, events } = engine()
    const first = dictation.start({ localeId: 'fr-FR' })
    children[0].say({ type: 'listening' })
    await first
    const second = dictation.start({ localeId: 'en-US' })
    expect(children[0].stdin.written).toEqual(['cancel\n'])
    children[0].say({ type: 'words', text: 'ancienne', final: false })
    children[1].say({ type: 'listening' })
    expect(await second).toBe(true)
    children[1].say({ type: 'words', text: 'new', final: false })
    expect(events).toEqual([{ type: 'words', text: 'new', final: false }])
  })
  it('the microphone sign: on while listening, off at the end of audio, at done, error, stop, cancel and exit', async () => {
    const run = async (end) => {
      const setup = engine()
      const started = setup.dictation.start({ localeId: 'fr-FR' })
      setup.children[0].say({ type: 'listening' })
      await started
      expect(setup.microphone).toEqual([true])
      end(setup)
      return setup.microphone
    }
    expect(await run(({ children }) => children[0].say({ type: 'audioEnd' }))).toEqual([true, false])
    expect(await run(({ children }) => children[0].say({ type: 'error', code: 'error_network' }))).toEqual([true, false])
    expect(await run(({ children }) => { children[0].say({ type: 'words', text: 'a', final: true }); children[0].say({ type: 'done' }) })).toEqual([true, false])
    expect(await run(({ dictation }) => dictation.stop())).toEqual([true, false])
    expect(await run(({ dictation }) => dictation.cancel())).toEqual([true, false])
    expect(await run(({ children }) => children[0].exit(9))).toEqual([true, false])
  })

  it('a stop asked before the microphone runs never shows the sign', async () => {
    const { dictation, children, microphone } = engine()
    const started = dictation.start({ localeId: 'fr-FR' })
    dictation.stop()
    children[0].say({ type: 'listening' })
    await started
    expect(microphone).toEqual([])
  })

  it('caps the session at what the caller allows', async () => {
    const { dictation, calls } = engine()
    void dictation.start({ localeId: 'fr-FR', listenForMs: 120_000 }, { maxListenMs: 60_000 })
    expect(calls[0].args).toContain('60000')
    expect(calls[0].args).not.toContain('120000')
  })
})
