import { describe, expect, it } from 'vitest'
import { approvalAccepted } from './approval'

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
