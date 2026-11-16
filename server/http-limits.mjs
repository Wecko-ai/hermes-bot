import { Transform } from 'node:stream'
import path from 'node:path'

export const PROXY_JSON_MAX_BYTES = 64 * 1024 * 1024
export const IMAGE_MAX_BYTES = 64 * 1024 * 1024
export const DOCUMENT_TEXT_MAX_BYTES = 16 * 1024 * 1024

const tooLarge = () => Object.assign(new Error('upstream_too_large'), { status: 502 })

/** Reads an upstream body, or throws `upstream_too_large` (502) once `maxBytes` is passed. */
export async function readCappedText(upstream, maxBytes = PROXY_JSON_MAX_BYTES) {
  const declared = Number(upstream.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await upstream.body?.cancel?.().catch(() => {})
    throw tooLarge()
  }
  if (!upstream.body?.getReader) {
    const text = await upstream.text()
    if (Buffer.byteLength(text) > maxBytes) throw tooLarge()
    return text
  }
  const reader = upstream.body.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel().catch(() => {})
        throw tooLarge()
      }
      chunks.push(Buffer.from(value))
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Total size from a `Content-Range` (`bytes 0-1/99`), or null when the total is a star or absent. */
export function contentRangeTotal(header) {
  if (typeof header !== 'string') return null
  const match = /\/(\d+)\s*$/.exec(header)
  if (!match) return null
  const total = Number(match[1])
  return Number.isSafeInteger(total) ? total : null
}

/**
 * 413 when a capped relay is larger than `maxBytes`, including a 206 whose range names a
 * total over the cap. Uncapped relays (audio, video, pdf) pass.
 */
export function relayLimitStatus(status, headers, maxBytes) {
  if (!Number.isFinite(maxBytes)) return 0
  const length = Number(headers.get('content-length') || 0)
  if (Number.isFinite(length) && length > maxBytes) return 413
  if (status === 206) {
    const total = contentRangeTotal(headers.get('content-range'))
    if (total !== null && total > maxBytes) return 413
  }
  return 0
}

/** Counts streamed bytes and errors once they pass `maxBytes`, even with no content-length. */
export function createByteCap(maxBytes) {
  let seen = 0
  return new Transform({
    transform(chunk, _encoding, callback) {
      if (!Number.isFinite(maxBytes)) {
        callback(null, chunk)
        return
      }
      seen += chunk.length
      if (seen > maxBytes) {
        callback(Object.assign(new Error('document_too_large'), { code: 'ERR_DOCUMENT_TOO_LARGE' }))
        return
      }
      callback(null, chunk)
    },
  })
}

const RANGE_HEADERS = ['range', 'if-range']
const CONDITIONAL_HEADERS = ['if-none-match', 'if-modified-since']

/** Forwards conditional headers. `Range` only when the caller asked (pdf, audio, video). */
export function forwardRequestHeaders(requestHeaders, { forwardRange }) {
  const headers = { 'accept-encoding': 'identity' }
  const names = forwardRange ? [...RANGE_HEADERS, ...CONDITIONAL_HEADERS] : CONDITIONAL_HEADERS
  for (const name of names) {
    const value = requestHeaders[name]
    if (typeof value === 'string' && value.length <= 200) headers[name] = value
  }
  return headers
}

/** Fingerprinted build files live under `/assets/`. Everything else is revalidated. */
export function staticCacheControl(file) {
  const parts = String(file).split(path.sep)
  const assets = parts.lastIndexOf('assets')
  if (assets >= 0 && assets < parts.length - 1) return 'public, max-age=31536000, immutable'
  return 'no-cache'
}

export function isApiPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/')
}
