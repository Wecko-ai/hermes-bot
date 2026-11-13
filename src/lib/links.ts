// Top-level domains a scheme-less web address may end in. A short list on purpose: `notes.md` or
// `build.sh` look like hosts too, and must never become links to the web.
const TLDS = 'com|org|net|io|ai|app|dev|co|fr|eu|de|uk|us|ca|es|it|nl|be|ch|info|me|tv|xyz|gg|cloud|tech|so|ly|fm|gov|edu'
const WEB_ADDRESS = new RegExp(`^(?:www\\.[a-z0-9-]+(?:\\.[a-z0-9-]+)*|(?:[a-z0-9-]+\\.)+(?:${TLDS}))(?::\\d{1,5})?(?:[/?#]|$)`, 'i')

/**
 * The href to render for a link in a bot message. An address written without its scheme
 * (`www.example.com/x`, `example.com/path`, `//example.com`) gets `https://`, so it does not
 * resolve against the app's own origin. Everything else is returned unchanged: hash links
 * (`#media:2`), mentions, `mailto:`, links with a scheme, absolute and relative paths.
 */
export function normalizeHref(href: string | undefined): string | undefined {
  if (!href) return href
  const value = href.trim()
  if (!value || value.startsWith('#') || value.startsWith('/') && !value.startsWith('//') || value.startsWith('.') || value.startsWith('~')) return href
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z0-9.-]+:\d{1,5}(?:[/?#]|$)/i.test(value)) return href
  if (value.startsWith('//')) return /^\/\/[^/\s]+\.[a-z]{2,}/i.test(value) ? `https:${value}` : href
  return WEB_ADDRESS.test(value) ? `https://${value}` : href
}
