import { describe, expect, it } from 'vitest'
import { approvalAccepted, serverApprovalPrompt } from './approval'

describe('approvalAccepted', () => {
  it('keeps the card when the send resolves to false', async () => {
    expect(await approvalAccepted(false)).toBe(false)
    expect(await approvalAccepted(Promise.resolve(false))).toBe(false)
  })

  it('records the approval for anything else', async () => {
    expect(await approvalAccepted(true)).toBe(true)
    expect(await approvalAccepted(undefined)).toBe(true)
    expect(await approvalAccepted(Promise.resolve())).toBe(true)
  })
})

describe('serverApprovalPrompt', () => {
  it('maps a JSON-RPC approval to an in-thread card', () => {
    const prompt = serverApprovalPrompt({
      id: 'srq-1',
      method: 'approval',
      params: { session_id: 'chat-orion', command: 'rm -rf tmp', description: 'Delete folder', choices: ['once', 'deny'] },
    }, 3)
    expect(prompt?.kind).toBe('approval')
    expect(prompt?.serverRequestId).toBe('srq-1')
    expect(prompt?.generation).toBe(3)
    expect(prompt?.command).toBe('rm -rf tmp')
  })
})
