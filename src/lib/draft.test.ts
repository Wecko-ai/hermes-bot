import { describe, expect, it } from 'vitest'
import { canSendDraft, parseDraftBlock } from './draft'

const block = [
  'Id: post-1',
  'Channel: slack',
  'Recipient: #general',
  'Thread: ',
  'Attachments: ',
  '',
  'Hello team',
].join('\n')

describe('parseDraftBlock', () => {
  it('reads channel, recipient and body', () => {
    const draft = parseDraftBlock(block)
    expect(draft?.channel).toBe('slack')
    expect(draft?.recipient).toBe('#general')
    expect(draft?.text).toBe('Hello team')
    expect(canSendDraft(draft!)).toBe(true)
  })

  it('rejects unknown channels', () => {
    expect(parseDraftBlock(block.replace('slack', 'irc'))).toBeNull()
  })
})