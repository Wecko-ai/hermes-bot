import { describe, expect, it } from 'vitest'
import { isRetryableTurnComplete, turnFallbackError } from './auto-route-turn'

describe('auto route in-turn errors', () => {
  it('detects retryable provider completions', () => {
    expect(isRetryableTurnComplete({ status: 'error', error: { code: 'rate_limit_exceeded', message: '429' } })).toBe(true)
    expect(isRetryableTurnComplete({ status: 'complete', text: 'ok' })).toBe(false)
    expect(isRetryableTurnComplete({ status: 'error', text: 'provider unavailable' })).toBe(true)
  })

  it('formats fallback error labels', () => {
    expect(turnFallbackError({ error: { code: 'rate_limit' } })).toBe('429')
    expect(turnFallbackError({ error: { message: 'upstream refused' } })).toBe('error:upstream refused')
  })
})