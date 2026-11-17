/**
 * The models each provider listed lately, kept on this Mac. The gateway's catalog cache is keyed on its
 * credential files: each OAuth refresh makes the next `model.options` answer with Hermes's built-in list
 * while it warms the real one again, and that built-in list lacks recent models (Sonnet 5.5, Haiku 5.5).
 * A model listed in the last days stays offered through that window instead of vanishing from the picker.
 */
const STORAGE_KEY = 'hermesbot-model-memory'
export const MODEL_MEMORY_MS = 7 * 24 * 60 * 60 * 1000

/** Per provider slug: its models in picker order, each with the last time a listing had it. */
export type ModelMemory = Record<string, Array<[model: string, seen: number]>>

export function readModelMemory(): ModelMemory {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const memory: ModelMemory = {}
    for (const [slug, rows] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(rows)) continue
      memory[slug] = rows.filter((row): row is [string, number] => Array.isArray(row) && typeof row[0] === 'string' && typeof row[1] === 'number')
    }
    return memory
  } catch {
    return {}
  }
}

export function writeModelMemory(memory: ModelMemory) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(memory)) } catch { /* storage unavailable */ }
}

/**
 * The provider's models to offer: the listed ones, plus those listed within `MODEL_MEMORY_MS` and missing
 * now (each placed after the model it followed), unless the gateway marks them unavailable. Returns the
 * memory to keep: the listed models seen now, the others keep their time until they expire.
 */
export function withRememberedModels(listed: string[], remembered: Array<[string, number]> = [], now = Date.now(), unavailable: ReadonlySet<string> = new Set()) {
  const result = [...listed]
  const present = new Set(listed)
  const recent = remembered.filter(([model, seen]) => now - seen < MODEL_MEMORY_MS && !unavailable.has(model))
  recent.forEach(([model], index) => {
    if (present.has(model)) return
    let at = 0
    for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
      const position = result.indexOf(recent[earlier][0])
      if (position >= 0) {
        at = position + 1
        break
      }
    }
    result.splice(at, 0, model)
    present.add(model)
  })
  const seen = new Map(recent)
  listed.forEach((model) => seen.set(model, now))
  return { models: result, memory: result.map((model): [string, number] => [model, seen.get(model) ?? now]) }
}
