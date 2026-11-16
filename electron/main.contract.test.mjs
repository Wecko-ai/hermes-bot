import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./main.cjs', import.meta.url), 'utf8')

describe('main process wiring', () => {
  it('installs process guards before the server module is imported', () => {
    const guard = source.indexOf('installProcessGuards()')
    const server = source.indexOf("'server', 'index.mjs'")
    expect(guard).toBeGreaterThan(-1)
    expect(server).toBeGreaterThan(guard)
  })

  it('does not switch to a client of whoever holds port 4330', () => {
    expect(source).not.toContain('clientMode')
    expect(source).not.toContain('hermesBotAlreadyServing')
    expect(source).not.toContain('dictationConsent')
    expect(source).toContain('requestSingleInstanceLock')
    expect(source).toContain("'second-instance'")
    expect(source).toContain('portTaken')
  })

  it('registers navigation, permission, and quit handlers', () => {
    expect(source).toContain("'will-redirect'")
    expect(source).toContain('setPermissionRequestHandler')
    expect(source).toContain('setPermissionCheckHandler')
    expect(source).toContain('setDevicePermissionHandler')
    expect(source.indexOf("on('closed'")).toBeLessThan(source.indexOf('loadURL'))
    expect(source).not.toContain("on('activate'")
    expect(source).toContain("on('SIGTERM'")
    expect(source).toContain("on('SIGINT'")
    expect(source).toContain('stopHermesTunnel()')
    expect(source).toContain('stopVaultTunnel()')
    expect(source).toContain('app.quit()')
  })

  it('checks restart-tunnel and focus-window with fromWindow, and arms dictation from a token', () => {
    expect(source).not.toContain('senderFrame?.url.startsWith')
    expect(source).toContain('gate.mayPrepare()')
    expect(source).toContain('gate.armStart(token)')
    expect(source).toContain('__hermesBotVaultToken')
    expect(source).not.toContain('process.env.HERMESBOT_VAULT_TOKEN =')
    expect(source).not.toContain('Enter or Space')
  })
})
