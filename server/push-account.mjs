/** Opaque push account id, matching HermesBot iPhone (`PushController._accountId`). */

export function fnv1a64Hex(input) {
  const text = String(input)
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index))
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}

export function pushAccountId(origin, user) {
  return fnv1a64Hex(`${String(origin || '').trim()}|${String(user || '').trim()}`)
}