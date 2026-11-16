import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { installProcessGuards, shouldInstallProcessGuards } from './process-guards.mjs'

describe('process guards', () => {
  it('installs fatal and shutdown listeners only outside Electron', () => {
    expect(shouldInstallProcessGuards({})).toBe(true)
    expect(shouldInstallProcessGuards({ electron: '44.0.0' })).toBe(false)

    const standalone = new EventEmitter()
    standalone.versions = {}
    const errors = []
    expect(installProcessGuards(standalone, {
      onShutdown: () => errors.push('down'),
      onError: (error) => errors.push(error),
    })).toBe(true)
    expect(standalone.listenerCount('uncaughtException')).toBe(1)
    expect(standalone.listenerCount('unhandledRejection')).toBe(1)
    expect(standalone.listenerCount('SIGINT')).toBe(1)
    expect(standalone.listenerCount('SIGTERM')).toBe(1)
    standalone.emit('SIGTERM')
    expect(errors).toEqual(['down'])

    const electron = new EventEmitter()
    electron.versions = { electron: '44.0.0' }
    expect(installProcessGuards(electron, { onShutdown() {}, onError() {} })).toBe(false)
    expect(electron.listenerCount('SIGTERM')).toBe(0)
    expect(electron.listenerCount('uncaughtException')).toBe(0)
  })
})
