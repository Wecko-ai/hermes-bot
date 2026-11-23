import { createHmac, timingSafeEqual } from 'node:crypto'

function safeEqual(a, b) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export function verifyBearer(request, secret) {
  const header = String(request.headers.authorization || '')
  if (!header.startsWith('Bearer ')) return false
  return safeEqual(header.slice(7).trim(), secret)
}

export function verifyHmacBody(body, secret, request) {
  const header = String(request.headers['x-webhook-signature'] || request.headers['x-hermes-webhook-signature'] || '')
  if (!header) return false
  const digest = createHmac('sha256', secret).update(body).digest('hex')
  const expected = header.startsWith('sha256=') ? header.slice(7) : header
  return safeEqual(expected, digest)
}

/** GitHub `X-Hub-Signature-256: sha256=<hex>` */
export function verifyGithubSignature(body, secret, request) {
  const header = String(request.headers['x-hub-signature-256'] || '')
  if (!header.startsWith('sha256=')) return false
  const digest = createHmac('sha256', secret).update(body).digest('hex')
  return safeEqual(header.slice(7), digest)
}

export function verifyWebhookAuth({ preset, auth, secret, body, request }) {
  if (!secret) return false
  if (preset === 'github') return verifyGithubSignature(body, secret, request)
  if (auth === 'hmac') return verifyHmacBody(body, secret, request)
  return verifyBearer(request, secret)
}