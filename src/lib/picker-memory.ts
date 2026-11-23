/**
 * The model picker choice for each Bot Chat, kept on this device. Auto is only a picker sentinel;
 * the gateway session stores the model that actually answered. Without this memory, reopening a
 * chat (or the app) would show that routed model instead of Auto, or lose an explicit pick.
 */
const STORAGE_KEY = 'hermesbot-picker-memory'
const MEMORY_LIMIT = 200

export type PickerMemory = Record<string, string>

/** Used when `localStorage` is missing (tests, some WebViews). */
let memoryCache = '{}'

function readRaw(): string {
  try {
    if (typeof localStorage !== 'undefined') return localStorage.getItem(STORAGE_KEY) || memoryCache
  } catch { /* storage unavailable */ }
  return memoryCache
}

function writeRaw(value: string) {
  memoryCache = value
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, value)
  } catch { /* storage unavailable */ }
}

export function readPickerMemory(): PickerMemory {
  try {
    const parsed: unknown = JSON.parse(readRaw() || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const memory: PickerMemory = {}
    for (const [sessionId, model] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof sessionId === 'string' && sessionId && typeof model === 'string' && model.length < 400) {
        memory[sessionId] = model
      }
    }
    return memory
  } catch {
    return {}
  }
}

export function pickerForSession(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined
  const model = readPickerMemory()[sessionId]
  return model || undefined
}

export function writePickerForSession(sessionId: string | undefined, pickerModel: string) {
  if (!sessionId) return
  const memory = readPickerMemory()
  delete memory[sessionId]
  const ordered = { ...memory, [sessionId]: pickerModel }
  const keys = Object.keys(ordered)
  const trimmed = keys.length <= MEMORY_LIMIT
    ? ordered
    : Object.fromEntries(keys.slice(keys.length - MEMORY_LIMIT).map((key) => [key, ordered[key]]))
  writeRaw(JSON.stringify(trimmed))
}

export function clearPickerMemory() {
  memoryCache = '{}'
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY)
  } catch { /* storage unavailable */ }
}
