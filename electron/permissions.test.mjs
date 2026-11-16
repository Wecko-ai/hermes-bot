import { describe, expect, it } from 'vitest'
import permissions from './permissions.cjs'

const { grantPermission, grantDevicePermission, ALLOWED_PERMISSIONS } = permissions
const ORIGIN = 'http://127.0.0.1:4330'
const page = `${ORIGIN}/`

function allow(permission, extra = {}) {
  return grantPermission(permission, { isMainFrame: true, requestingUrl: page, origin: ORIGIN, ...extra })
}

describe('renderer permissions', () => {
  it('grants only notifications, clipboard write, and fullscreen on the app main frame', () => {
    expect([...ALLOWED_PERMISSIONS].sort()).toEqual(['clipboard-sanitized-write', 'fullscreen', 'notifications'])
    for (const permission of ALLOWED_PERMISSIONS) expect(allow(permission), permission).toBe(true)
  })

  it('never grants media, even on the app origin main frame', () => {
    expect(allow('media')).toBe(false)
    expect(allow('display-capture')).toBe(false)
    expect(allow('mediaKeySystem')).toBe(false)
    for (const permission of ['geolocation', 'midi', 'midiSysex', 'hid', 'serial', 'usb', 'clipboard-read', 'pointerLock', 'openExternal', 'unknown']) {
      expect(allow(permission), permission).toBe(false)
    }
  })

  it('refuses the allowed permissions from a subframe, another port, or a missing document', () => {
    expect(allow('notifications', { isMainFrame: false })).toBe(false)
    expect(allow('fullscreen', { requestingUrl: `${ORIGIN}/api/document?path=a.pdf` , isMainFrame: false })).toBe(false)
    expect(allow('clipboard-sanitized-write', { requestingUrl: 'http://127.0.0.1:4331/' })).toBe(false)
    expect(allow('notifications', { requestingUrl: 'http://localhost:4330/' })).toBe(false)
    expect(allow('notifications', { requestingUrl: undefined })).toBe(false)
    expect(allow('notifications', { isMainFrame: undefined })).toBe(false)
    expect(grantPermission('notifications')).toBe(false)
  })

  it('refuses every device', () => {
    expect(grantDevicePermission()).toBe(false)
    expect(grantDevicePermission({ deviceType: 'hid', origin: ORIGIN })).toBe(false)
    expect(grantDevicePermission({ deviceType: 'serial' })).toBe(false)
    expect(grantDevicePermission({ deviceType: 'usb' })).toBe(false)
  })
})
