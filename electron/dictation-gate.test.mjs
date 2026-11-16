import { describe, expect, it } from 'vitest'
import gateModule from './dictation-gate.cjs'

const { createDictationGate, isGesture, GESTURE_MS, START_WINDOW_MS, MAX_LISTEN_MS } = gateModule

function clock(start = 1_000_000) {
  let time = start
  return { now: () => time, advance: (ms) => { time += ms } }
}

const inFront = { focused: true, visible: true }
const click = { type: 'mouseDown', button: 'left' }
const enter = { type: 'keyDown', key: 'Enter', isAutoRepeat: false }

function prepare(gate, input = click) {
  gate.noteInput(input)
  return gate.mayPrepare()
}

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
    expect(gate.mayPrepare()).toBeNull()
  })

  it('prepare only right after a gesture, and the gesture is consumed', () => {
    const time = clock()
    const gate = createDictationGate({ now: time.now })
    expect(gate.mayPrepare()).toBeNull()
    gate.noteInput(click)
    time.advance(GESTURE_MS)
    const token = gate.mayPrepare()
    expect(token).toEqual({ generation: expect.any(Number) })
    expect(gate.mayPrepare()).toBeNull()
    gate.noteInput(click)
    time.advance(GESTURE_MS + 1)
    expect(gate.mayPrepare()).toBeNull()
    gate.noteInput(enter)
    expect(gate.mayPrepare()).not.toBeNull()
  })

  it('one gesture authorizes one prepare', () => {
    const gate = createDictationGate({ now: clock().now })
    gate.noteInput(click)
    const token = gate.mayPrepare()
    expect(token).not.toBeNull()
    expect(gate.mayPrepare()).toBeNull()
    expect(gate.armStart(token)).toBe(true)
    expect(gate.armStart(token)).toBe(false)
  })

  it('two prepares need two gestures', () => {
    const gate = createDictationGate({ now: clock().now })
    gate.noteInput(click)
    const first = gate.mayPrepare()
    expect(gate.mayPrepare()).toBeNull()
    gate.noteInput(enter)
    const second = gate.mayPrepare()
    expect(second).not.toBeNull()
    expect(gate.armStart(first)).toBe(false)
    expect(gate.armStart(second)).toBe(true)
  })

  it('disarm during prepare invalidates arming', () => {
    const gate = createDictationGate({ now: clock().now })
    const token = prepare(gate)
    gate.disarm()
    expect(gate.armStart(token)).toBe(false)
    expect(gate.takeStart(inFront)).toBe(false)
  })

  it('a new gesture during prepare invalidates the token already issued', () => {
    const gate = createDictationGate({ now: clock().now })
    const token = prepare(gate)
    gate.noteInput(click)
    expect(gate.armStart(token)).toBe(false)
    const next = gate.mayPrepare()
    expect(gate.armStart(next)).toBe(true)
  })

  it('one start per armed prepare, shortly after it', () => {
    const time = clock()
    const gate = createDictationGate({ now: time.now })
    expect(gate.takeStart(inFront)).toBe(false)
    expect(gate.armStart(null)).toBe(false)
    expect(gate.armStart(prepare(gate))).toBe(true)
    expect(gate.takeStart(inFront)).toBe(true)
    expect(gate.takeStart(inFront)).toBe(false)
    expect(gate.armStart(prepare(gate))).toBe(true)
    time.advance(START_WINDOW_MS + 1)
    expect(gate.takeStart(inFront)).toBe(false)
    expect(gate.armStart(prepare(gate))).toBe(true)
    gate.disarm()
    expect(gate.takeStart(inFront)).toBe(false)
  })

  it('the window must be focused and visible, and a refused start uses up the right', () => {
    const gate = createDictationGate({ now: clock().now })
    expect(gate.armStart(prepare(gate))).toBe(true)
    expect(gate.takeStart({ focused: false, visible: true })).toBe(false)
    expect(gate.takeStart(inFront)).toBe(false)
    expect(gate.armStart(prepare(gate))).toBe(true)
    expect(gate.takeStart({ focused: true, visible: false })).toBe(false)
    expect(gate.armStart(prepare(gate))).toBe(true)
    expect(gate.takeStart({ focused: 'yes', visible: true })).toBe(false)
  })

  it('sessions last two minutes and are not paced', () => {
    const time = clock()
    const gate = createDictationGate({ now: time.now })
    expect(gate.armStart(prepare(gate))).toBe(true)
    expect(gate.takeStart(inFront)).toBe(true)
    time.advance(1)
    expect(gate.armStart(prepare(gate))).toBe(true)
    expect(gate.takeStart(inFront)).toBe(true)
    expect(gate.maxListenMs()).toBe(MAX_LISTEN_MS)
    expect(MAX_LISTEN_MS).toBe(120_000)
  })

  it('ignores a retired client-mode option and keeps the two-minute cap', () => {
    const gate = createDictationGate({ clientMode: true, now: clock().now })
    expect(gate.maxListenMs()).toBe(MAX_LISTEN_MS)
    expect(gate.needsConsent).toBeUndefined()
    expect(gate.refused).toBeUndefined()
    expect(gate.setConsent).toBeUndefined()
  })
})
