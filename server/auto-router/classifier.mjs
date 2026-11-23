/** Deterministic prompt category (no model call). */

export const CATEGORIES = ['coding', 'research', 'quick', 'long_context', 'vision', 'writing', 'other']

const CODE = /\b(code|bug|fix|refactor|typescript|javascript|python|rust|swift|compile|lint|test suite|unit test|function|class|api|git|pr\b|pull request|implémente|corrige|débug|fichier\s+\.(ts|js|py)|npm run)\b/i
const CODE_FR = /\b(code|dépannage|compilation|dépôt|branche|fusion|typage)\b/i
const RESEARCH = /\b(research|search|find|analyze|compare|sources?|literature|investigate|explore|summarize papers?|quelle est|trouve|recherche|analyse|compare|sources?)\b/i
const WRITING = /\b(write|draft|email|mail|blog|post|essay|article|rewrite|proofread|rédige|écris|brouillon|courriel|article|poste)\b/i
const QUICK = /^\s*[\wÀ-ÿ\s]{1,120}[?.!]?\s*$/

export function estimateTokens(text, contextUsed = 0) {
  const prompt = Math.ceil(String(text || '').length / 4)
  return prompt + Math.max(0, contextUsed)
}

/**
 * @param {{ text: string, imageCount?: number, contextUsed?: number, contextMax?: number }} input
 */
export function classifyPrompt(input) {
  const text = String(input.text || '')
  const imageCount = Number(input.imageCount) || 0
  const contextUsed = Number(input.contextUsed) || 0
  const contextMax = Number(input.contextMax) || 0
  const tokens = estimateTokens(text, contextUsed)

  if (imageCount > 0) return 'vision'

  const longByTokens = tokens >= 32_000
  const longBySession = contextMax > 0 && contextUsed / contextMax >= 0.7
  if (longByTokens || longBySession) return 'long_context'

  const lower = text.toLowerCase()
  if (CODE.test(lower) || CODE_FR.test(lower) || /```/.test(text)) return 'coding'
  if (RESEARCH.test(lower)) return 'research'
  if (WRITING.test(lower)) return 'writing'

  const trimmed = text.trim()
  if (trimmed.length <= 140 && QUICK.test(trimmed) && !/```/.test(text)) return 'quick'

  return 'other'
}