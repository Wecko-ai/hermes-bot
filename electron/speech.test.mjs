import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import speechModule from './speech.cjs'

const { createSpeech, maySay, parseEvent, sayLine, parseVoices } = speechModule

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
  const speech = createSpeech({
    helperPath: '/helper',
    onEvent: (event) => events.push(event),
    exists: () => helperPresent,
    spawnImpl: (path, args, options) => {
      calls.push({ path, args, options })
      const child = fakeChild()
      children.push(child)
      return child
    },
  })
  return { speech, children, calls, events }
}

const utterance = (over = {}) => ({ id: 1, text: 'Bonjour', language: 'fr-FR', ...over })

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('parseEvent whitelist', () => {
  it('keeps well-formed events and clamps levels', () => {
    expect(parseEvent('{"type":"ready"}')).toEqual({ type: 'ready' })
    expect(parseEvent('{"type":"start","id":3}')).toEqual({ type: 'start', id: 3 })
    expect(parseEvent('{"type":"level","id":3,"rms":1.7,"bands":[-1,0.5,2]}')).toEqual({ type: 'level', id: 3, rms: 1, bands: [0, 0.5, 1] })
    expect(parseEvent('{"type":"end","id":3,"interrupted":true}')).toEqual({ type: 'end', id: 3, interrupted: true })
    expect(parseEvent('{"type":"error","code":"error_synth"}')).toEqual({ type: 'error', code: 'error_synth' })
    expect(parseEvent('{"type":"error","id":2,"code":"error_synth"}')).toEqual({ type: 'error', id: 2, code: 'error_synth' })
  })

  it('drops everything else', () => {
    for (const line of [
      'nope', '[]', 'null', '{"type":"words","text":"x"}',
      '{"type":"start","id":0}', '{"type":"start","id":1.5}', '{"type":"start","id":2147483648}', '{"type":"start","id":"1"}',
      '{"type":"level","id":1,"rms":"x","bands":[]}', '{"type":"level","id":1,"rms":0.1,"bands":"x"}',
      `{"type":"level","id":1,"rms":0.1,"bands":[${Array(17).fill(0).join(',')}]}`,
      '{"type":"level","id":1,"rms":0.1,"bands":[null]}',
      '{"type":"end","id":1}', '{"type":"end","id":1,"interrupted":"yes"}',
      '{"type":"error","code":"boom"}', '{"type":"error","code":"error_Bad"}', '{"type":"error","id":-1,"code":"error_x"}',
    ]) expect(parseEvent(line), line).toBeNull()
  })
})

describe('utterance validation', () => {
  it('accepts a good utterance and defaults the rate', () => {
    expect(sayLine(utterance())).toEqual({ op: 'say', id: 1, text: 'Bonjour', language: 'fr-FR', rate: 1 })
    expect(sayLine(utterance({ language: 'en', voice: 'v', rate: 2 }))).toMatchObject({ voice: 'v', rate: 2, language: 'en' })
  })

  it('refuses bad ones', () => {
    for (const bad of [
      null, 'x', utterance({ id: 0 }), utterance({ id: 1.2 }), utterance({ id: 2 ** 31 }),
      utterance({ text: '' }), utterance({ text: 'a'.repeat(4001) }), utterance({ text: 5 }),
      utterance({ voice: 'v'.repeat(201) }), utterance({ voice: 3 }),
      utterance({ language: 'fr-fr' }), utterance({ language: 'french' }), utterance({ language: undefined }),
      utterance({ rate: 0.4 }), utterance({ rate: 2.1 }), utterance({ rate: Number.NaN }), utterance({ rate: '1' }),
    ]) expect(sayLine(bad)).toBeNull()
    expect(sayLine(utterance({ text: 'a'.repeat(4000) }))).not.toBeNull()
  })
})

describe('say, events, isSpeaking', () => {
  it('spawns lazily with an argv array and a minimal environment', () => {
    const { speech, calls } = engine()
    expect(calls).toHaveLength(0)
    expect(speech.say(utterance())).toBe(true)
    expect(calls[0].args).toEqual(['speak'])
    expect(calls[0].options.env).toEqual({ PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' })
    expect(calls[0].options.stdio).toEqual(['pipe', 'pipe', 'ignore'])
  })

  it('writes one JSON line per utterance and refuses invalid or duplicate ones', () => {
    const { speech, children } = engine()
    expect(speech.say(utterance({ text: '' }))).toBe(false)
    expect(children).toHaveLength(0)
    expect(speech.say(utterance())).toBe(true)
    expect(speech.say(utterance())).toBe(false)
    expect(children[0].stdin.written).toEqual(['{"op":"say","id":1,"text":"Bonjour","language":"fr-FR","rate":1}\n'])
  })

  it('tracks accepted ids until each has ended or failed; ignores unknown ids', () => {
    const { speech, children, events } = engine()
    speech.say(utterance({ id: 1 }))
    speech.say(utterance({ id: 2 }))
    expect(speech.isSpeaking()).toBe(true)
    children[0].say({ type: 'ready' })
    children[0].say({ type: 'start', id: 99 })
    children[0].say({ type: 'start', id: 1 })
    children[0].say({ type: 'level', id: 1, rms: 0.4, bands: [0.1] })
    children[0].say({ type: 'end', id: 1, interrupted: false })
    expect(speech.isSpeaking()).toBe(true)
    children[0].say({ type: 'error', id: 2, code: 'error_synth' })
    expect(speech.isSpeaking()).toBe(false)
    expect(events.map((e) => e.type)).toEqual(['start', 'level', 'end', 'error'])
  })

  it('forwards an error without id', () => {
    const { speech, children, events } = engine()
    speech.say(utterance())
    children[0].say({ type: 'error', code: 'error_audio' })
    expect(events).toEqual([{ type: 'error', code: 'error_audio' }])
    expect(speech.isSpeaking()).toBe(true)
  })

  it('stop writes the stop op and closes what the helper does not', () => {
    const { speech, children, events } = engine()
    speech.say(utterance({ id: 1 }))
    speech.say(utterance({ id: 2 }))
    speech.stop()
    expect(children[0].stdin.written.at(-1)).toBe('{"op":"stop"}\n')
    children[0].say({ type: 'end', id: 1, interrupted: true })
    vi.advanceTimersByTime(1_000)
    expect(events).toEqual([{ type: 'end', id: 1, interrupted: true }, { type: 'end', id: 2, interrupted: true }])
    expect(speech.isSpeaking()).toBe(false)
  })

  it('stop with no helper does nothing', () => {
    const { speech, calls } = engine()
    speech.stop()
    expect(calls).toHaveLength(0)
  })

  it('a crash reports error_helper_exited for each pending id, then respawns', () => {
    const { speech, children, events } = engine()
    speech.say(utterance({ id: 1 }))
    speech.say(utterance({ id: 2 }))
    children[0].exit(1)
    expect(events).toEqual([
      { type: 'error', id: 1, code: 'error_helper_exited' },
      { type: 'error', id: 2, code: 'error_helper_exited' },
    ])
    expect(speech.isSpeaking()).toBe(false)
    expect(speech.say(utterance({ id: 3 }))).toBe(true)
    expect(children).toHaveLength(2)
  })

  it('a spawn error reports the same way', () => {
    const { speech, children, events } = engine()
    speech.say(utterance())
    children[0].emit('error', new Error('x'))
    expect(events).toEqual([{ type: 'error', id: 1, code: 'error_helper_exited' }])
  })

  it('events of a dead helper are ignored', () => {
    const { speech, children, events } = engine()
    speech.say(utterance())
    children[0].exit(1)
    events.length = 0
    children[0].say({ type: 'start', id: 1 })
    expect(events).toEqual([])
  })

  it('a missing helper binary refuses everything', async () => {
    const { speech, calls } = engine({ helperPresent: false })
    expect(speech.say(utterance())).toBe(false)
    expect(await speech.voices()).toEqual([])
    expect(calls).toHaveLength(0)
  })
})

describe('idle and dispose', () => {
  it('kills the helper 60 s after the last utterance ended, and respawns later', () => {
    const { speech, children } = engine()
    speech.say(utterance())
    children[0].say({ type: 'end', id: 1, interrupted: false })
    vi.advanceTimersByTime(59_000)
    expect(children[0].killed).toEqual([])
    vi.advanceTimersByTime(1_000)
    expect(children[0].killed).toContain('SIGTERM')
    expect(speech.say(utterance({ id: 2 }))).toBe(true)
    expect(children).toHaveLength(2)
  })

  it('does not idle-kill while something is pending, and a new say resets the clock', () => {
    const { speech, children } = engine()
    speech.say(utterance({ id: 1 }))
    vi.advanceTimersByTime(120_000)
    expect(children[0].killed).toEqual([])
    children[0].say({ type: 'end', id: 1, interrupted: false })
    vi.advanceTimersByTime(30_000)
    speech.say(utterance({ id: 2 }))
    vi.advanceTimersByTime(45_000)
    expect(children[0].killed).toEqual([])
  })

  it('dispose closes stdin, terminates, escalates to SIGKILL, and reports nothing', () => {
    const { speech, children, events } = engine()
    const stubborn = children
    speech.say(utterance())
    const child = stubborn[0]
    child.kill = (signal) => { child.killed.push(signal) }
    speech.dispose()
    expect(child.stdin.writable).toBe(false)
    expect(child.killed).toEqual(['SIGTERM'])
    vi.advanceTimersByTime(2_000)
    expect(child.killed).toEqual(['SIGTERM', 'SIGKILL'])
    child.exit()
    expect(events).toEqual([])
    expect(speech.isSpeaking()).toBe(false)
  })
})

describe('voices', () => {
  const entry = { id: 'com.apple.voice.x', name: 'Amélie', language: 'fr-CA', quality: 'enhanced' }

  it('returns validated voices', async () => {
    const { speech, children, calls } = engine()
    const promise = speech.voices()
    expect(calls[0].args).toEqual(['voices'])
    children[0].say({ voices: [entry, { ...entry, quality: 'ultra' }, { ...entry, language: 'fr_FR' }, { ...entry, id: '' }, { ...entry, name: 'n'.repeat(101) }, 5] })
    children[0].exit(0)
    expect(await promise).toEqual([entry])
  })

  it('caps the list at 300', async () => {
    const { speech, children } = engine()
    const promise = speech.voices()
    children[0].say({ voices: Array.from({ length: 400 }, (_, i) => ({ ...entry, id: `v${i}` })) })
    children[0].exit(0)
    expect(await promise).toHaveLength(300)
  })

  it('answers [] on a bad line, a non-zero exit, a spawn error, or a timeout', async () => {
    let e = engine()
    let p = e.speech.voices()
    e.children[0].stdout.emit('data', 'garbage\n')
    e.children[0].exit(0)
    expect(await p).toEqual([])

    e = engine()
    p = e.speech.voices()
    e.children[0].say({ voices: [entry] })
    e.children[0].exit(1)
    expect(await p).toEqual([])

    e = engine()
    p = e.speech.voices()
    e.children[0].emit('error', new Error('x'))
    expect(await p).toEqual([])

    e = engine()
    p = e.speech.voices()
    vi.advanceTimersByTime(5_000)
    expect(e.children[0].killed).toEqual(['SIGKILL'])
    expect(await p).toEqual([])
  })

  it('parseVoices rejects non-objects', () => {
    expect(parseVoices('{"voices":3}')).toBeNull()
    expect(parseVoices('x')).toBeNull()
  })
})

describe('half-duplex decision', () => {
  it('allows the voice only with the microphone closed and no dictation session', () => {
    expect(maySay({ microphoneOpen: false, dictationActive: false })).toBe(true)
    expect(maySay({ microphoneOpen: true, dictationActive: false })).toBe(false)
    expect(maySay({ microphoneOpen: false, dictationActive: true })).toBe(false)
  })
})
