// Which navigations the app window may follow.
//
// The main frame stays on this app (`origin` + a path), the same rule as `will-navigate`.
// A subframe (the document tab) may load only `/api/document` on that origin. Two exceptions
// keep the PDF plugin working: Electron's built-in PDF viewer, and `about:blank`. The PDF
// iframe is not sandboxed; a sandbox would stop that plugin. Everything else is cancelled,
// including data:, blob:, javascript:, file:, and custom schemes.

const PDF_VIEWER_PREFIX = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/'

function isOwnPage(url, origin) {
  return typeof url === 'string' && typeof origin === 'string' && origin.length > 0 && url.startsWith(`${origin}/`)
}

function isAboutBlank(url) {
  return typeof url === 'string' && /^about:blank(?:[?#]|$)/.test(url)
}

function isPdfViewer(url) {
  return typeof url === 'string' && url.startsWith(PDF_VIEWER_PREFIX)
}

function isDocumentRoute(url, origin) {
  if (typeof url !== 'string' || typeof origin !== 'string') return false
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return parsed.origin === origin && parsed.pathname === '/api/document'
}

function allowsMainFrameNavigation(url, origin) {
  return isOwnPage(url, origin)
}

function allowsSubframeNavigation(url, origin) {
  return isAboutBlank(url) || isPdfViewer(url) || isDocumentRoute(url, origin)
}

function allowsNavigation(url, { isMainFrame, origin } = {}) {
  if (isMainFrame === true) return allowsMainFrameNavigation(url, origin)
  if (isMainFrame === false) return allowsSubframeNavigation(url, origin)
  return false
}

/** Cancel a navigation the predicate refuses. `openOutside` runs only for a refused main frame. */
function guardNavigation(event, { origin, openOutside } = {}) {
  if (!event || allowsNavigation(event.url, { isMainFrame: event.isMainFrame, origin })) return
  if (typeof event.preventDefault === 'function') event.preventDefault()
  if (event.isMainFrame === true && typeof openOutside === 'function') openOutside(event.url)
}

module.exports = {
  PDF_VIEWER_PREFIX,
  allowsNavigation,
  allowsMainFrameNavigation,
  allowsSubframeNavigation,
  isDocumentRoute,
  guardNavigation,
}
