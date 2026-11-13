import { describe, expect, it } from 'vitest'
import gateModule from './dictation-gate.cjs'

const { createDictationGate, isGesture, GESTURE_MS, START_WINDOW_MS, CLIENT_START_INTERVAL_MS, CLIENT_MAX_LISTEN_MS, MAX_LISTEN_MS } = gateModule

function clock(start = 1_000_000) {
  let time = start
  return { now: () => time, advance: (ms) => { time += ms } }
}

const inFront = { focused: true, visible: true }
const click = { type: 'mouseDown', button: 'left' }
const enter = { type: 'keyDown', key: 'Enter', isAutoRepeat: false }

describe('dictation gate', () => {
  it('only a click, or Enter pressed once, is a gesture', () => {
    expect(isGesture(click)).toBe(true)
    expect(isGesture(enter)).toBe(true)
    for (const input of [
      // Space is typed between every two words: it never counts.
      { type: 'keyDown', key: ' ', isAutoRepeat: false },
      { type: 'keyDown', key: 'a', isAutoRepeat: false },
      { type: 'keyDown', key: 'Backspace', isAutoRepeat: false },
      { type: 'keyDown', key: 'Enter', isAutoRepeat: true },
      { type: 'keyDown', key: ' ', isAutoRepeat: true },
      { type: 'keyUp', key: 'Enter', isAutoRepeat: false },
      { type: 'mouseUp' },
      { type: 'mouseMove' },
      { type: 'mouseWheel' },
      null,
    ]) expect(isGesture(input), JSON.stringify(input)).toBe(false)
  })

  it('typing never arms the gate', () => {
    const gate = createDictationGate({ now: clock().now })
    for (const key of 'Bonjour à tous') gate.noteInput({ type: 'keyDown', key, isAutoRepeat: false })
    gate.noteInput({ type: 'keyDown', key: 'Enter', isAutoRepeat: true })
    expect(gate.mayPrepare()).toBe(false)
  })

  it('prepare only right after a gesture', () => {
    const time = clock()
    const gate = createDictationGate({ now: time.now })
    expect(gate.mayPrepare()).toBe(false)
    gate.noteInput(click)
    expect(gate.mayPrepare()).toBe(true)
    time.advance(GESTURE_MS)
    expect(gate.mayPrepare()).toBe(true)
    time.advance(1)
    expect(gate.mayPrepare()).toBe(false)
    gate.noteInput(enter)
    expect(gate.mayPrepare()).toBe(true)
  })

  it('one start per accepted prepare, shortly after it', () => {
    const time = clock()
    const gate = createDictationGate({ now: time.now })
    expect(gate.takeStart(inFront)).toBe(false)
    gate.armStart()
    expect(gate.takeStart(inFront)).toBe(true)
    expect(gate.takeStart(inFront)).toBe(false)
    gate.armStart()
    time.advance(START_WINDOW_MS + 1)
    expect(gate.takeStart(inFront)).toBe(false)
    gate.armStart()
    gate.disarm()
    expect(gate.takeStart(inFront)).toBe(false)
  })

  it('the window must be focused and visible, and a refused start uses up the right', () => {
    const gate = createDictationGate({ now: clock().now })
    gate.armStart()
    expect(gate.takeStart({ focused: false, visible: true })).toBe(false)
    expect(gate.takeStart(inFront)).toBe(false)
    gate.armStart()
    expect(gate.takeStart({ focused: true, visible: false })).toBe(false)
    gate.armStart()
    expect(gate.takeStart({ focused: 'yes', visible: true })).toBe(false)
  })

  it('own server: no consent, no pacing, two minutes at most', () => {
    const time = clock()
    const gate = createDictationGate({ clientMode: false, now: time.now })
    expect(gate.needsConsent()).toBe(false)
    expect(gate.refused()).toBe(false)
    gate.armStart()
    expect(gate.takeStart(inFront)).toBe(true)
    gate.armStart()
    expect(gate.takeStart(inFront)).toBe(true)
    expect(gate.maxListenMs()).toBe(MAX_LISTEN_MS)
  })

  it('client mode: consent asked once per launch, never read from disk, a refusal holds', () => {
    const gate = createDictationGate({ clientMode: true, consent: 'granted' })
    expect(gate.needsConsent()).toBe(true)
    gate.setConsent('granted')
    expect(gate.needsConsent()).toBe(false)
    expect(gate.refused()).toBe(false)
    // A new launch is a new gate: asked again.
    expect(createDictationGate({ clientMode: true }).needsConsent()).toBe(true)
    const refused = createDictationGate({ clientMode: true })
    refused.setConsent('denied')
    expect(refused.needsConsent()).toBe(false)
    expect(refused.refused()).toBe(true)
  })

  it('client mode: one start every 5 s at most, one minute per session', () => {
    const time = clock()
    const gate = createDictationGate({ clientMode: true, now: time.now })
    gate.armStart()
    expect(gate.takeStart(inFront)).toBe(true)
    time.advance(CLIENT_START_INTERVAL_MS - 1)
    gate.armStart()
    expect(gate.takeStart(inFront)).toBe(false)
    time.advance(1)
    gate.armStart()
    expect(gate.takeStart(inFront)).toBe(true)
    expect(gate.maxListenMs()).toBe(CLIENT_MAX_LISTEN_MS)
  })
})
