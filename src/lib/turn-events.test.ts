import { describe, expect, it } from 'vitest'
import { HermesRpcError } from './hermes'
import {
  appendSessionStream,
  completedText,
  interruptGenerationForPriority,
  interruptLeftSessionIdle,
  isRunningTurnEnd,
  replayGapResumes,
  takeSessionStream,
} from './turn-events'

describe('message.complete', () => {
  it('does not end the running turn for a cancelled or replaced queued admission', () => {
    expect(isRunningTurnEnd({ payload: { text: '', admission_id: 'adm-1', outcome: 'cancelled' } })).toBe(false)
    expect(isRunningTurnEnd({ payload: { text: '', outcome: 'steered' } })).toBe(false)
    expect(isRunningTurnEnd({ payload: { text: '   ', outcome: 'cancelled' } })).toBe(false)
    expect(isRunningTurnEnd({ payload: {} })).toBe(false)
  })

  it('ends the turn on a terminal status or an execution generation', () => {
    expect(isRunningTurnEnd({ execution_generation: 4, payload: { text: 'Done.', status: 'complete' } })).toBe(true)
    expect(isRunningTurnEnd({ execution_generation: 4, payload: { text: '', status: 'interrupted', outcome: 'cancelled' } })).toBe(true)
    expect(isRunningTurnEnd({ execution_generation: 4, payload: { text: '', status: 'error' } })).toBe(true)
    expect(isRunningTurnEnd({ execution_generation: 4, payload: { text: '' } })).toBe(true)
    expect(isRunningTurnEnd({ payload: { status: 'complete', text: '', outcome: 'cancelled' } })).toBe(true)
  })

  it('uses the streaming buffer when the completion text is empty', () => {
    expect(completedText('', 'partial reply')).toBe('partial reply')
    expect(completedText('   ', 'partial reply')).toBe('partial reply')
    expect(completedText(undefined, 'partial reply')).toBe('partial reply')
    expect(completedText('Final.', 'partial reply')).toBe('Final.')
    const buffers = new Map<string, string>()
    appendSessionStream(buffers, 'chat-a', 'Hel')
    appendSessionStream(buffers, 'chat-a', 'lo')
    appendSessionStream(buffers, 'chat-b', 'Other')
    expect(takeSessionStream(buffers, 'chat-a')).toBe('Hello')
    expect(buffers.has('chat-a')).toBe(false)
    expect(buffers.get('chat-b')).toBe('Other')
  })
})

describe('priority interrupt', () => {
  it('keeps the generation copied before submit when the store moves on', () => {
    expect(interruptGenerationForPriority(4, 9)).toBe(4)
    expect(interruptGenerationForPriority(4, 4)).toBe(4)
  })

  it('does not retry with a newer generation after stale_generation', () => {
    const stale = new HermesRpcError('stale_generation', { reason: 'stale_generation' })
    expect(interruptGenerationForPriority(4, 9, stale)).toBeNull()
    expect(interruptGenerationForPriority(4, 9, new Error('timeout'))).toBeNull()
  })

  it('resumes only the open session after a replay gap', () => {
    expect(replayGapResumes('chat-a', 'chat-a')).toBe(true)
    expect(replayGapResumes('chat-b', 'chat-a')).toBe(false)
    expect(replayGapResumes(undefined, 'chat-a')).toBe(false)
  })

  it('treats an idle interrupt result as a finished turn', () => {
    expect(interruptLeftSessionIdle({ execution_state: 'idle', execution_generation: 1 })).toBe(true)
    expect(interruptLeftSessionIdle({ execution_state: 'running' })).toBe(false)
    expect(interruptLeftSessionIdle(null)).toBe(false)
  })
})
