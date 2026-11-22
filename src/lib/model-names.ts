/**
 * Readable model names. One pattern for every family, the one Anthropic's names already follow:
 * Family, then tier words, then the version ("gemini-3.5-flash" -> "Gemini Flash 3.5").
 * Pure and offline: no table of models to keep up to date, only a few rules on the shape of an id.
 * Claude ids keep their short form ("Opus 5.5").
 */

export interface ParsedModel {
  family: string
  /** Words that name the tier or variant ("flash", "pro", "coder"), lower case, in id order. */
  tiers: string[]
  /** Bare numeric version ("3.5"), or an empty string. */
  version: string
  /** Version carrying a letter ("v4", "k3.1", "m2.7"): it stays in place, as in "DeepSeek V4 Flash". */
  prefixedVersion: string
  /** Parameter counts ("27B", "A12B"). */
  sizes: string[]
  /** Modifiers shown last ("preview", "thinking", "instruct"). */
  qualifiers: string[]
}

const WORD_CASE: Record<string, string> = {
  gpt: 'GPT', glm: 'GLM', deepseek: 'DeepSeek', minimax: 'MiniMax', mimo: 'MiMo', xai: 'xAI', oss: 'OSS',
  tts: 'TTS', vl: 'VL', it: 'IT', ocr: 'OCR', qwq: 'QwQ', llm: 'LLM', ai: 'AI', api: 'API', moe: 'MoE',
  glm5: 'GLM', openai: 'OpenAI', nvidia: 'NVIDIA', ibm: 'IBM', hy: 'HY',
}
const QUALIFIERS: Record<string, string> = {
  preview: 'Preview', exp: 'Experimental', experimental: 'Experimental', latest: 'Latest', beta: 'Beta',
  instruct: 'Instruct', thinking: 'Thinking', reasoning: 'Reasoning', nonreasoning: 'Non-reasoning', chat: 'Chat', it: 'IT',
}
// Suffixes that carry no information for a name (the free status stays visible elsewhere).
const DROPPED = new Set(['free', 'web', 'extended', 'online', 'nitro', 'floor', 'latest-free', 'mlx', 'gguf', 'community'])
const SMALL_WORDS = new Set(['for', 'of', 'and', 'in'])
export const DOTTED_PREFIX = /^(?:[a-z]+\.)+(?=[a-z])/i
const SAFE_ID = /^[A-Za-z0-9._:/@+-]{1,200}$/

const titleWord = (word: string) => WORD_CASE[word] ?? (SMALL_WORDS.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1))

// Marketed names that hide another model behind them, checked verbatim against the bare id before
// the pattern rules. Verified by hand: the target ages, so each entry carries its check date.
const ALIASES: Record<string, string> = {
  // Kimi Code's "for coding" endpoint serves K2.8 Preview (canonical moonshotai/kimi-k2.8-preview).
  'kimi-for-coding': 'Kimi K2.8 Preview', // vérifié 2026-11-22
}

/** Date and quantisation parts of an id: they identify a build, not a model. */
function stripNoise(name: string) {
  return name
    .replace(/-20\d{2}-\d{2}-\d{2}(?=-|$)/g, '')
    .replace(/-(?:20\d{6}|\d{6})(?=-|$)/g, '')
    .replace(/-\d{4}(?=-|$)/g, '')
    .replace(/-(?:[248]|16)bit(?=-|$)/gi, '')
    .replace(/-(?:bf16|fp16|fp8|q\d\w*|awq|gptq)(?=-|$)/gi, '')
}

/** Splits an id into family, tier words, version, sizes and qualifiers. `null` when it has no usable shape. */
export function parseModelId(raw: string): ParsedModel | null {
  const id = raw.replace(/^~/, '')
  if (!SAFE_ID.test(id)) return null
  let name = id.split('/').pop() || ''
  // Bedrock-style publisher prefixes: "au.anthropic.claude-haiku-5-5", "meta.llama4-...".
  name = name.replace(DOTTED_PREFIX, '')
  // "mlx-community--Qwen3.8-27B-4bit": the publisher is the part before the double dash.
  if (name.includes('--')) name = name.split('--').pop() || name
  name = name.replace(/@[a-z0-9-]+$/i, '')
  const suffixes: string[] = []
  const colon = name.indexOf(':')
  if (colon >= 0) {
    suffixes.push(...name.slice(colon + 1).split(':'))
    name = name.slice(0, colon)
    // Bedrock revision "-v1:0".
    if (/^\d+$/.test(suffixes[0] ?? '')) name = name.replace(/-v\d+$/i, '')
  }
  name = stripNoise(name.toLowerCase()).replace(/non-reasoning/g, 'nonreasoning')

  const pieces: string[] = []
  for (const part of name.split('-')) {
    if (!part) continue
    // "qwen3.8" -> "qwen", "3.8" (two letters or more: "k3" and "o3" stay whole).
    const glued = /^([a-z]{2,})(\d[\d.]*)$/.exec(part)
    if (glued && !/^a\d+b$/.test(part)) pieces.push(glued[1], glued[2])
    else pieces.push(part)
  }
  for (const suffix of suffixes) {
    const lower = suffix.toLowerCase()
    if (/^\d+(\.\d+)?[bmkt]$/.test(lower)) pieces.push(lower)
    else if (lower in QUALIFIERS) pieces.push(lower)
    else if (lower === 'fast') pieces.push('fast')
  }

  // Two small numbers in a row are one version: "5-5" -> "5.5", "k3","1" -> "k3.1".
  const tokens: string[] = []
  for (const piece of pieces) {
    const last = tokens[tokens.length - 1]
    if (last !== undefined && /^\d{1,2}$/.test(piece) && /^\d{1,2}$/.test(last) && tokens.length > 1) tokens[tokens.length - 1] = `${last}.${piece}`
    else if (last !== undefined && /^\d{1,2}$/.test(piece) && /^[a-z]\d+$/.test(last)) tokens[tokens.length - 1] = `${last}.${piece}`
    else tokens.push(piece)
  }

  let family = ''
  let version = ''
  let prefixedVersion = ''
  const tiers: string[] = []
  const sizes: string[] = []
  const qualifiers: string[] = []
  for (const token of tokens) {
    if (DROPPED.has(token)) continue
    if (/^\d+(\.\d+)?[bmkt]$/.test(token) || /^a\d+(\.\d+)?b$/.test(token)) sizes.push(token.toUpperCase())
    else if (/^\d+(\.\d+)*$/.test(token)) {
      // The first bare number is the version; a second one (two numbers not merged above) is kept as a word.
      if (!version) version = token
      else tiers.push(token)
    } else if (/^[a-z]\d+(\.\d+)*$/.test(token)) {
      // OpenAI writes its reasoning line "o3"; the others capitalise ("K3", "V4").
      if (!prefixedVersion) prefixedVersion = token.startsWith('o') ? token : token.toUpperCase()
      else tiers.push(token)
    } else if (token in QUALIFIERS) qualifiers.push(token)
    else if (!family && !prefixedVersion) family = token
    else tiers.push(token)
  }
  if (!family && !prefixedVersion) return null
  // Prefixed version first in the id and no family ("k3.1-pro"): it is the name itself.
  return { family, tiers, version, prefixedVersion, sizes, qualifiers }
}

/** "gemini-3.5-flash" -> "Gemini Flash 3.5". Unknown shapes keep the raw id rather than a wrong name. */
export function prettyModelName(id: string, _provider?: string): string {
  const bare = id.replace(/^~/, '').split('/').pop() ?? ''
  const alias = ALIASES[bare.replace(DOTTED_PREFIX, '')]
  if (alias) return alias
  const parsed = parseModelId(id)
  if (!parsed) return id
  const parts: string[] = []
  if (parsed.family) parts.push(titleWord(parsed.family))
  if (parsed.prefixedVersion) parts.push(parsed.prefixedVersion)
  parts.push(...parsed.tiers.map(titleWord))
  if (parsed.version) parts.push(parsed.version)
  parts.push(...parsed.sizes)
  parts.push(...parsed.qualifiers.map((qualifier) => QUALIFIERS[qualifier]))
  const name = parts.join(' ').trim()
  return name || id
}

const matchWords = (parsed: ParsedModel) => [parsed.family, parsed.prefixedVersion.toLowerCase(), ...parsed.tiers].filter(Boolean)

/** Canonical key of a model for matching two catalogs: family, tiers (sorted), version and sizes. Qualifiers are not part of it. */
export function modelMatchKey(id: string): string | null {
  const parsed = parseModelId(id)
  // Without a version or a size, "gemini-pro-latest" would match any Gemini Pro.
  if (!parsed || (!parsed.version && !parsed.prefixedVersion && parsed.sizes.length === 0)) return null
  const words = matchWords(parsed)
  return `${[...words].sort().join('+')}|${parsed.version}|${parsed.sizes.join('+')}`
}

export function modelQualifiers(id: string): string[] {
  return parseModelId(id)?.qualifiers ?? []
}
