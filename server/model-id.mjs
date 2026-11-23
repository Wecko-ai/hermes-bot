/**
 * Model ids that may be routed or probed.
 * Strict charset so an id cannot be a shell word or a path: no whitespace, no `..`,
 * no quotes, `$`, backticks or separators. `@`, `/` and `:` are allowed
 * (`@cf/meta/…`, `provider/model`, `vendor/name:free`). Length is capped at 200.
 */

export const MODEL_ID_MAX = 200

const MODEL_ID = /^[@A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/

export function isSafeModelId(value) {
  if (typeof value !== 'string') return false
  if (value.length < 1 || value.length > MODEL_ID_MAX) return false
  if (value.includes('..')) return false
  return MODEL_ID.test(value)
}
