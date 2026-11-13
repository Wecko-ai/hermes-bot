import { describe, expect, it } from 'vitest'
import gateModule from './dictation-gate.cjs'

const { createDictationGate, GESTURE_MS, START_WINDOW_MS } = gateModule

function clock(start = 1_000_000) {
  let time = start
  return { now: () => time, advance: (ms) => { time += ms } }
}

const inFront = { focused: true, visible: true }

describe('dictation gate', () => {
  it('prepare only right after a real gesture', () => {
    const time = clock()
    const gate = createDictationGate({ now: time.now })
    expect(gate.mayPrepare()).toBe(false)
    gate.noteGesture()
    expect(gate.mayPrepare()).toBe(true)
    time.advance(GESTURE_MS)
    expect(gate.mayPrepare()).toBe(true)
    time.advance(1)
    expect(gate.mayPrepare()).toBe(false)
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

  it('own server: no consent to ask', () => {
    const gate = createDictationGate({ clientMode: false })
    expect(gate.needsConsent()).toBe(false)
    expect(gate.refused()).toBe(false)
  })

  it('client mode: asked once, an agreement is kept, a refusal holds for the launch', () => {
    const fresh = createDictationGate({ clientMode: true })
    expect(fresh.needsConsent()).toBe(true)
    fresh.setConsent('granted')
    expect(fresh.needsConsent()).toBe(false)
    expect(fresh.refused()).toBe(false)

    const remembered = createDictationGate({ clientMode: true, consent: 'granted' })
    expect(remembered.needsConsent()).toBe(false)

    const refused = createDictationGate({ clientMode: true })
    refused.setConsent('denied')
    expect(refused.needsConsent()).toBe(false)
    expect(refused.refused()).toBe(true)

    // Anything else read from disk is no agreement.
    expect(createDictationGate({ clientMode: true, consent: 'denied' }).needsConsent()).toBe(true)
    expect(createDictationGate({ clientMode: true, consent: true }).needsConsent()).toBe(true)
  })
})
