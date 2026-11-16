import { describe, expect, it } from 'vitest'
import { claimSend, modelRefreshApplies, releaseSend, sendBlockedWhileRunning, stillOnProfile } from './send-guard'

describe('send guard', () => {
  it('keeps screen writes on the bot that owns the send', () => {
    expect(stillOnProfile('alpha', 'alpha')).toBe(true)
    expect(stillOnProfile('beta', 'alpha')).toBe(false)
    expect(stillOnProfile('', 'alpha')).toBe(false)
    expect(stillOnProfile(undefined, 'alpha')).toBe(false)
  })

  it('refuses a second send for a profile already in flight', () => {
    const inFlight = new Set<string>()
    expect(claimSend(inFlight, 'alpha')).toBe(true)
    expect(claimSend(inFlight, 'alpha')).toBe(false)
    expect(claimSend(inFlight, 'beta')).toBe(true)
    releaseSend(inFlight, 'alpha')
    expect(claimSend(inFlight, 'alpha')).toBe(true)
  })

  it('blocks a normal send while that bot is running, not a queue or a priority', () => {
    expect(sendBlockedWhileRunning(true, undefined)).toBe(true)
    expect(sendBlockedWhileRunning(true, 'queue')).toBe(false)
    expect(sendBlockedWhileRunning(true, 'priority')).toBe(false)
    expect(sendBlockedWhileRunning(false, undefined)).toBe(false)
  })

  it('drops a model list that is stale or for another bot', () => {
    expect(modelRefreshApplies(2, 2, 'alpha', 'alpha')).toBe(true)
    expect(modelRefreshApplies(1, 2, 'alpha', 'alpha')).toBe(false)
    expect(modelRefreshApplies(2, 2, 'alpha', 'beta')).toBe(false)
  })
})
