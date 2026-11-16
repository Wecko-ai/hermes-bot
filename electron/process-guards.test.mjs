import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import guards from './process-guards.cjs'

const { installProcessGuards, errorText } = guards

describe('process guards', () => {
  it('logs the message and stack of an uncaught error, and nothing else on the object', () => {
    const lines = []
    const target = new EventEmitter()
    installProcessGuards(target, (line) => lines.push(line))
    const error = new Error('socket reset')
    error.body = 'password=secret-token'
    error.headers = { cookie: 'hermes_session=secret-token' }
    target.emit('uncaughtException', error)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('uncaughtException')
    expect(lines[0]).toContain('socket reset')
    expect(lines[0]).toContain('process-guards.test.mjs')
    expect(lines[0]).not.toContain('secret-token')
    expect(lines[0]).not.toContain('password=')
    expect(lines[0]).not.toContain('hermes_session')
  })

  it('logs a rejection reason without dumping a plain object', () => {
    const lines = []
    const target = new EventEmitter()
    installProcessGuards(target, (line) => lines.push(line))
    target.emit('unhandledRejection', { token: 'secret-token', body: 'raw request' })
    target.emit('unhandledRejection', 'gateway closed')
    expect(lines[0]).toBe('[hermes-bot] unhandledRejection: unknown error')
    expect(lines[0]).not.toContain('secret-token')
    expect(lines[1]).toContain('gateway closed')
    expect(errorText({ token: 'secret-token' })).toBe('unknown error')
  })

  it('keeps going when the logger throws', () => {
    const target = new EventEmitter()
    installProcessGuards(target, () => { throw new Error('log failed') })
    expect(() => target.emit('uncaughtException', new Error('boom'))).not.toThrow()
  })
})
