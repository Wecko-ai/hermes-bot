import { describe, expect, it } from 'vitest'
import { acceptLoadedConversation, replyAnnouncement, streamMayCommit } from './local-chat-turn'

const quiet = { startedGeneration: 1, currentGeneration: 1, messagesChanged: false, streamActive: false, conversationChanged: false }

describe('local chat turn guards', () => {
  it('commits a stream only while its generation is current', () => {
    expect(streamMayCommit(3, 3)).toBe(true)
    expect(streamMayCommit(3, 4)).toBe(false)
  })

  it('ignores a saved conversation when a send started or the conversation changed', () => {
    expect(acceptLoadedConversation(quiet)).toBe(true)
    expect(acceptLoadedConversation({ ...quiet, messagesChanged: true })).toBe(false)
    expect(acceptLoadedConversation({ ...quiet, streamActive: true })).toBe(false)
    expect(acceptLoadedConversation({ ...quiet, conversationChanged: true })).toBe(false)
    expect(acceptLoadedConversation({ ...quiet, currentGeneration: 2 })).toBe(false)
  })

  it('announces a finished reply once and stays quiet while tokens arrive', () => {
    expect(replyAnnouncement(true, 'Hel')).toBeNull()
    expect(replyAnnouncement(true, 'Hello')).toBeNull()
    expect(replyAnnouncement(false, 'Hello')).toBe('Hello')
    expect(replyAnnouncement(false, '  ')).toBeNull()
  })
})
