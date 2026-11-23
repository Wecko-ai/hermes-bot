import { describe, expect, it } from 'vitest'
import fixture from '../../tests/fixtures/fallback-turn.json'
import { completeUsage, parseUsage } from './hermes'
import { formatUsage } from './model'
import {
  answeredLabel, answeredStorageIds, composerChipText, composerReadout, reduceFallbackTurn, rememberAnswered, withRememberedAnswers,
  type FallbackTurnState, type KeyValueStore,
} from './turn-model'
import type { ChatMessage, SessionUsage } from '../types'

const memoryStore = (): KeyValueStore => {
  const saved = new Map<string, string>()
  return {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => { saved.set(key, value) },
  }
}

const usageOf = (payload: Record<string, unknown>): SessionUsage | null => {
  const parsed = parseUsage({ ...payload, ...(payload.usage as object | undefined) })
  return parsed ? completeUsage(parsed) : null
}

describe('fallback turn', () => {
  const selected = fixture.selected
  const events = fixture.events

  it('replays a gateway fallback and shows the model that answered', () => {
    let state: FallbackTurnState = { answered: null, fresh: true, storedIds: [] }
    const readout: Array<string | null> = []
    for (const event of events) {
      const usage = event.type === 'session.usage' || event.type === 'message.complete' ? usageOf(event.payload) : null
      state = reduceFallbackTurn(state, event, selected, usage)
      const running = event.type !== 'message.complete'
      readout.push(formatUsage(composerReadout(usage, { running, fresh: state.fresh, answered: running ? state.answered : null })))
    }

    expect(state.answered?.model).toBe('cursor/composer-2.5')
    expect(state.answered?.provider).toBe('cursor')
    expect(answeredLabel(state.answered!, '(secours)')).toBe('Composer 2.5 · Cursor (secours)')
    expect(answeredLabel(state.answered!, '(fallback)')).toBe('Composer 2.5 · Cursor (fallback)')
    // The selected model's estimated frame stays a dash; the answering model's frame does not.
    expect(readout[1]).toBe(formatUsage(null))
    expect(readout[2]).toBe(formatUsage(null))
    expect(readout[3]).toContain('34')
    expect(readout[3]).toContain('76')
    expect(state.storedIds).toEqual(expect.arrayContaining(['11944', '11945']))
    expect(composerChipText({
      answered: state.answered,
      chatModel: selected,
      fallbackMark: '(secours)',
    })).toBe('Composer 2.5 · Cursor (secours)')
    expect(composerChipText({
      answered: null,
      chatModel: 'cursor/gpt-5.6-sol',
      fallbackMark: '(secours)',
    })).toBe('GPT 5.6 Sol · Cursor')
  })

  it('keeps the fallback on the reloaded rows', () => {
    const storage = memoryStore()
    const answered = reduceFallbackTurn(
      { answered: null, fresh: false, storedIds: [] },
      events[1],
      selected,
    ).answered!
    const ids = answeredStorageIds(events[4].payload, 'local-user')
    rememberAnswered('20261106_162541_895ce4', ids, answered, storage)
    const history: ChatMessage[] = [
      { id: '11944', role: 'user', content: 'le mail', createdAt: null },
      { id: '11945', role: 'assistant', content: 'Noté.', createdAt: null },
    ]
    const restored = withRememberedAnswers('20261106_162541_895ce4', history, storage)
    expect(restored[0].answeredBy?.model).toBe('cursor/composer-2.5')
    expect(restored[1].answeredBy?.model).toBe('cursor/composer-2.5')
    expect(answeredLabel(restored[1].answeredBy!, '(secours)')).toBe('Composer 2.5 · Cursor (secours)')
  })

  it('ignores a usage flag that is still the selected model', () => {
    const state = reduceFallbackTurn(
      { answered: null, fresh: false, storedIds: [] },
      { type: 'session.usage', payload: { fallback_model: selected, model: selected, provider: 'custom' } },
      selected,
      completeUsage({ model: selected, provider: 'custom', contextMax: 1, contextUsed: 1, contextPercent: 1, averageTps: 9 }),
    )
    expect(state.answered).toBeNull()
  })
})
