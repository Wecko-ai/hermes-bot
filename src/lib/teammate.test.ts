import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isAcknowledgement,
  narrationFromEvent,
  nextNarration,
  parseTeammatePrefs,
  resetTeammatePrefs,
  saveTeammateFragment,
  setTeammateEnabled,
  settleAnswer,
  splitAssistantPieces,
  teammateApiText,
  teammateEnabled,
  teammateFragment,
  teammateNote,
  TEAMMATE_FRAGMENT,
} from './teammate'

describe('teammate note', () => {
  afterEach(() => {
    resetTeammatePrefs()
    vi.unstubAllGlobals()
  })

  it('is on for every profile until one opts out', () => {
    expect(teammateEnabled('nova')).toBe(true)
    expect(teammateEnabled('')).toBe(false)
    setTeammateEnabled('nova', false)
    expect(teammateEnabled('nova')).toBe(false)
    expect(teammateEnabled('orion')).toBe(true)
    setTeammateEnabled('nova', true)
    expect(teammateEnabled('nova')).toBe(true)
  })

  it('keeps one shared fragment, and an edit replaces the built-in text', () => {
    expect(teammateFragment()).toBe(TEAMMATE_FRAGMENT)
    expect(teammateNote()).toMatch(/^\[HermesBot teammate: You work in the background like a teammate\./)
    expect(teammateNote()).toMatch(/\]$/)
    expect(teammateNote()).not.toContain('PROGRESS:]')
    saveTeammateFragment('Reply first, then work, then one clear result.')
    expect(teammateFragment()).toBe('Reply first, then work, then one clear result.')
    expect(teammateNote()).toContain('Reply first, then work')
    saveTeammateFragment(TEAMMATE_FRAGMENT)
    expect(teammateFragment()).toBe(TEAMMATE_FRAGMENT)
  })

  it('drops brackets inside a custom fragment so the note stays one pair', () => {
    expect(teammateNote('Keep [progress] out')).toBe('[HermesBot teammate: Keep progress out]')
  })

  it('appends the note after the turn text only when the profile has it on', () => {
    expect(teammateApiText('Fix the tests', undefined, false)).toBeUndefined()
    expect(teammateApiText('Fix the tests', 'Fix the tests\n\n[HermesBot mode: PLAN.]', false)).toBe('Fix the tests\n\n[HermesBot mode: PLAN.]')
    expect(teammateApiText('Fix the tests', undefined, true)).toMatch(/^Fix the tests\n\n\[HermesBot teammate: /)
    const planned = teammateApiText('Fix the tests', 'Fix the tests\n\n[HermesBot mode: PLAN.]', true)
    expect(planned).toMatch(/^Fix the tests\n\n\[HermesBot mode: PLAN\.\]\n\n\[HermesBot teammate: /)
  })

  it('reads a saved opt-out and ignores a broken file', () => {
    expect(parseTeammatePrefs('{"disabled":["nova",1,"orion"],"fragment":"Short."}')).toEqual({ disabled: ['nova', 'orion'], fragment: 'Short.' })
    expect(parseTeammatePrefs('not json')).toEqual({ disabled: [], fragment: '' })
    expect(parseTeammatePrefs(null)).toEqual({ disabled: [], fragment: '' })
  })

  it('stays usable when storage throws', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } })
    expect(() => setTeammateEnabled('nova', false)).not.toThrow()
    expect(teammateEnabled('nova')).toBe(false)
  })
})

describe('progress events', () => {
  const now = '2026-11-22T10:00:00.000Z'
  const options = { teammate: true, sessionId: 'chat-1', now, silent: (text: string) => text === 'NOREPLY' }

  it('splits PROGRESS lines out of an assistant message and keeps the answer', () => {
    expect(splitAssistantPieces('On it.\n\nPROGRESS: Tests are running.\n\nAll green.')).toEqual([
      { text: 'On it.', progress: false },
      { text: 'Tests are running.', progress: true },
      { text: 'All green.', progress: false },
    ])
  })

  it('renders a progress event and a PROGRESS interim as one compact note, once', () => {
    const first = nextNarration(undefined, { type: 'progress', payload: { text: 'Socket stays closed after wake.' } }, options)
    expect(first.bubbles.map((bubble) => bubble.content)).toEqual(['Socket stays closed after wake.'])
    expect(first.bubbles[0]).toMatchObject({ role: 'assistant', progress: true })
    const again = nextNarration(first.state, { type: 'message.interim', payload: { text: 'PROGRESS: Socket stays closed after wake.' } }, options)
    expect(again.bubbles).toEqual([])
    const milestone = nextNarration(again.state, { type: 'message.progress', payload: { text: 'PROGRESS: Reconnect works. Full run is next.' } }, options)
    expect(milestone.bubbles.map((bubble) => bubble.content)).toEqual(['Reconnect works. Full run is next.'])
  })

  it('shows the acknowledgement once, and not when the profile opted out or the text is a step', () => {
    const ack = nextNarration(undefined, { type: 'message.interim', payload: { text: 'On it — I will fix the reconnect.' } }, options)
    expect(ack.bubbles).toEqual([expect.objectContaining({ ack: true, content: 'On it — I will fix the reconnect.' })])
    const second = nextNarration(ack.state, { type: 'message.interim', payload: { text: 'Still looking at the socket.' } }, options)
    expect(second.bubbles).toEqual([])
    const off = nextNarration(undefined, { type: 'message.interim', payload: { text: 'On it.' } }, { ...options, teammate: false })
    expect(off.bubbles).toEqual([])
    expect(isAcknowledgement('On it.')).toBe(true)
    expect(isAcknowledgement('I read the file. Then I will run the tests.')).toBe(false)
    expect(isAcknowledgement('PROGRESS: Tests are running.')).toBe(false)
    expect(isAcknowledgement('NOREPLY')).toBe(true)
    const silent = nextNarration(undefined, { type: 'message.interim', payload: { text: 'NOREPLY' } }, options)
    expect(silent.bubbles).toEqual([])
  })

  it('starts a new turn clean, and the final answer drops lines already shown', () => {
    const started = nextNarration({ ack: 'Old.', progress: ['Old milestone.'] }, { type: 'message.start' }, options)
    expect(started.state).toEqual({ progress: [] })
    const live = nextNarration(started.state, { type: 'message.interim', payload: { text: 'On it.\nPROGRESS: Tests are running.' } }, options)
    expect(live.bubbles.map((bubble) => [bubble.ack, bubble.progress, bubble.content])).toEqual([
      [undefined, true, 'Tests are running.'],
      [true, undefined, 'On it.'],
    ])
    expect(settleAnswer('On it.\n\nPROGRESS: Tests are running.\n\nPROGRESS: Full run is next.\n\nAll green.', live.state.progress, live.state.ack)).toEqual({
      answer: 'All green.',
      progress: ['Full run is next.'],
    })
  })

  it('reads a progress event with no prefix', () => {
    expect(narrationFromEvent({ type: 'progress', payload: { text: 'Two failures left.' } })).toEqual({ progress: ['Two failures left.'], interim: '' })
    expect(narrationFromEvent({ type: 'tool.start', payload: { text: 'PROGRESS: no' } })).toEqual({ progress: [], interim: '' })
  })
})
