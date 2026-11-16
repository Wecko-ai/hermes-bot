// Renderer permissions for the app window. Electron grants these by default when no handler
// is set, which would let the page open the microphone without the dictation gate.
//
// The page uses notifications, clipboard write (`navigator.clipboard.writeText`), and fullscreen
// (a `<video controls>` element). Nothing in the renderer calls getUserMedia, geolocation, midi,
// hid, serial, or usb. `media` is refused even for the app's own main frame.

const ORIGIN_DEFAULT = 'http://127.0.0.1:4330'
const ALLOWED_PERMISSIONS = new Set(['notifications', 'clipboard-sanitized-write', 'fullscreen'])

function isAppDocument(requestingUrl, origin) {
  if (typeof requestingUrl !== 'string' || typeof origin !== 'string' || !origin) return false
  if (requestingUrl !== origin && !requestingUrl.startsWith(`${origin}/`)) return false
  try {
    return new URL(requestingUrl).origin === origin
  } catch {
    return false
  }
}

/**
 * Whether a permission check or request from the renderer is granted.
 * Only the three permissions the page uses, and only its main frame on `origin`.
 */
function grantPermission(permission, { isMainFrame, requestingUrl, origin = ORIGIN_DEFAULT } = {}) {
  if (permission === 'media') return false
  if (!ALLOWED_PERMISSIONS.has(permission)) return false
  if (isMainFrame !== true) return false
  return isAppDocument(requestingUrl, origin)
}

/** Device prompts (hid, serial, usb, bluetooth). The page uses none of them. */
function grantDevicePermission() {
  return false
}

module.exports = { grantPermission, grantDevicePermission, ALLOWED_PERMISSIONS, isAppDocument }
