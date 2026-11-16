import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { describe, expect, it } from 'vitest'
import {
  DOCUMENT_TEXT_MAX_BYTES,
  IMAGE_MAX_BYTES,
  PROXY_JSON_MAX_BYTES,
  contentRangeTotal,
  createByteCap,
  forwardRequestHeaders,
  isApiPath,
  readCappedText,
  relayLimitStatus,
  staticCacheControl,
} from './http-limits.mjs'

function headers(entries) {
  return { get: (name) => entries[name.toLowerCase()] ?? null }
}

describe('readCappedText', () => {
  it('refuses a declared length over the cap without reading the body', async () => {
    let pulls = 0
    let cancelled = false
    const body = new ReadableStream({
      pull(controller) {
        pulls += 1
        controller.enqueue(new Uint8Array(8))
      },
      cancel() { cancelled = true },
    })
    const upstream = new Response(body, { headers: { 'content-length': String(PROXY_JSON_MAX_BYTES + 1) } })
    await expect(readCappedText(upstream)).rejects.toMatchObject({ message: 'upstream_too_large', status: 502 })
    expect(pulls).toBe(0)
    expect(cancelled).toBe(true)
  })

  it('stops a stream that never declares its length', async () => {
    let cancelled = false
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(400))
      },
      cancel() { cancelled = true },
    })
    const upstream = new Response(body)
    await expect(readCappedText(upstream, 1000)).rejects.toMatchObject({ message: 'upstream_too_large', status: 502 })
    expect(cancelled).toBe(true)
  })

  it('returns a body that fits', async () => {
    const upstream = new Response('{"ok":true}', { headers: { 'content-length': '11' } })
    expect(await readCappedText(upstream, 64)).toBe('{"ok":true}')
  })
})

describe('relay limits', () => {
  it('reads a content-range total and refuses a 206 of a file over the cap', () => {
    expect(contentRangeTotal('bytes 0-15/999')).toBe(999)
    expect(contentRangeTotal('bytes */4096')).toBe(4096)
    expect(contentRangeTotal('bytes 0-15/*')).toBeNull()
    expect(contentRangeTotal(null)).toBeNull()
    const over = headers({ 'content-length': '16', 'content-range': `bytes 0-15/${IMAGE_MAX_BYTES + 1}` })
    expect(relayLimitStatus(206, over, IMAGE_MAX_BYTES)).toBe(413)
    expect(relayLimitStatus(206, over, Infinity)).toBe(0)
    const honest = headers({ 'content-length': String(DOCUMENT_TEXT_MAX_BYTES + 1) })
    expect(relayLimitStatus(200, honest, DOCUMENT_TEXT_MAX_BYTES)).toBe(413)
    expect(relayLimitStatus(200, headers({}), DOCUMENT_TEXT_MAX_BYTES)).toBe(0)
  })

  it('aborts a stream once the running count passes the cap', async () => {
    const source = Readable.from([Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)])
    const chunks = []
    await expect(pipeline(source, createByteCap(10), async function* collect(stream) {
      for await (const chunk of stream) chunks.push(chunk)
    })).rejects.toMatchObject({ code: 'ERR_DOCUMENT_TOO_LARGE' })
    expect(Buffer.concat(chunks).length).toBeLessThanOrEqual(16)
  })

  it('forwards Range only when asked', () => {
    const request = { range: 'bytes=0-99', 'if-range': '"v"', 'if-none-match': '"e"', 'if-modified-since': 'yesterday' }
    expect(forwardRequestHeaders(request, { forwardRange: false })).toEqual({
      'accept-encoding': 'identity',
      'if-none-match': '"e"',
      'if-modified-since': 'yesterday',
    })
    expect(forwardRequestHeaders(request, { forwardRange: true }).range).toBe('bytes=0-99')
  })
})

describe('static responses', () => {
  it('marks only fingerprinted asset files immutable, and unknown API paths as API', () => {
    expect(staticCacheControl('/app/dist/assets/index-abc123.js')).toBe('public, max-age=31536000, immutable')
    expect(staticCacheControl('/app/dist/index.html')).toBe('no-cache')
    expect(staticCacheControl('/app/dist/favicon.ico')).toBe('no-cache')
    expect(isApiPath('/api/inconnu')).toBe(true)
    expect(isApiPath('/api')).toBe(true)
    expect(isApiPath('/health')).toBe(false)
    expect(isApiPath('/animations/bot-working.webp')).toBe(false)
  })
})
