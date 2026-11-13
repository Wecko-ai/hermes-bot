// Which links may leave the app for the system's default browser or mail app.
//
// shell.openExternal hands a URL to macOS, which opens whatever app claims its scheme: a custom scheme can start
// any installed app with arguments chosen by whoever wrote the link (a bot, a web page, a document). So only
// web pages and mail drafts go out. Never file: (it can open or run a local file), javascript:, data: or a
// custom scheme. The app's own server never goes out either: its pages belong in the app's window, and a
// browser holding one of its URLs is a needless copy of a local, signed-in address.

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '0.0.0.0'])

/** True for a URL served by the app's own local server, whatever loopback name it uses. */
function isAppUrl(url, appOrigin) {
  const app = new URL(appOrigin)
  if (url.origin === app.origin) return true
  const port = (value) => value.port || (value.protocol === 'https:' ? '443' : '80')
  return LOOPBACK_HOSTS.has(url.hostname) && LOOPBACK_HOSTS.has(app.hostname) && port(url) === port(app)
}

/** The URL to give to shell.openExternal, or null when the link must not leave the app. */
function externalUrl(raw, appOrigin) {
  if (typeof raw !== 'string') return null
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (!EXTERNAL_PROTOCOLS.has(url.protocol)) return null
  if (url.protocol === 'mailto:') return url.pathname ? url.href : null
  if (!url.hostname || isAppUrl(url, appOrigin)) return null
  return url.href
}

module.exports = { externalUrl }
