import { createHash } from 'node:crypto'

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
const MAX_PAYLOAD = 16_384

export async function readRawBody(request, limit = MAX_PAYLOAD) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new Error('payload_too_large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export function sanitizePayloadText(text) {
  const clean = String(text || '').replace(CONTROL, ' ').trim()
  return clean.length > MAX_PAYLOAD ? `${clean.slice(0, MAX_PAYLOAD)}…` : clean
}

export function payloadFromBody(buffer) {
  const raw = buffer.toString('utf8')
  try {
    const value = JSON.parse(raw)
    return sanitizePayloadText(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  } catch {
    return sanitizePayloadText(raw)
  }
}

export function dedupeKey(profile, jobId, body) {
  return createHash('sha256').update(`${profile}\0${jobId}\0${body}`).digest('hex')
}