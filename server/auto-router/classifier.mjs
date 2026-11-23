/** Deterministic prompt category (no model call). */

export const CATEGORIES = ['coding', 'research', 'quick', 'long_context', 'vision', 'writing', 'other']

const CODE = /\b(code|bug|fix|refactor|typescript|javascript|python|rust|swift|compile|lint|test suite|unit test|function|class|api|git|pr\b|pull request|implémente|corrige|débug|fichier\s+\.(ts|js|py)|npm run)\b/i
const CODE_FR = /\b(code|dépannage|compilation|dépôt|branche|fusion|typage)\b/i
const CODE_STRONG = /\b(typescript|javascript|python|rust|swift|refactor|compile|lint|test suite|unit test|pull request|implémente|corrige|débug|npm run|fichier\s+\.(ts|js|py))\b/i
const RESEARCH = /\b(research|search|find|analyze|compare|sources?|literature|investigate|explore|summarize papers?|quelle est|trouve|recherche|analyse|compare|sources?)\b/i
const RESEARCH_STRONG = /\b(research|literature|investigate|sources?|summarize papers?|recherche)\b/i
const WRITING = /\b(write|draft|email|mail|blog|post|essay|article|rewrite|proofread|rédige|écris|brouillon|courriel|article|poste)\b/i
const WRITING_STRONG = /\b(draft|blog|essay|article|rewrite|proofread|rédige|brouillon)\b/i
const QUICK = /^\s*[\wÀ-ÿ\s]{1,120}[?.!]?\s*$/
const QUICK_STRONG = /^(ok|okay|oui|non|yes|no|thanks?|merci|d['’]accord|s'il te pla[îi]t|please|👍|🙏|👌)[!?.…]*$/i

export function estimateTokens(text, contextUsed = 0) {
  const prompt = Math.ceil(String(text || '').length / 4)
  return prompt + Math.max(0, Number(contextUsed) || 0)
}

/**
 * @param {{ text: string, imageCount?: number, contextUsed?: number, contextMax?: number }} input
 * @returns {{ category: string, confidence: number, reason: string }}
 */
export function classifyPromptWithConfidence(input) {
  const text = String(input?.text || '')
  const imageCount = Number(input?.imageCount) || 0
  const contextUsed = Number(input?.contextUsed) || 0
  const contextMax = Number(input?.contextMax) || 0
  const tokens = estimateTokens(text, contextUsed)

  if (imageCount > 0) {
    return { category: 'vision', confidence: 1, reason: 'image attached' }
  }

  const longByTokens = tokens >= 32_000
  const longBySession = contextMax > 0 && contextUsed / contextMax >= 0.7
  if (longByTokens || longBySession) {
    return { category: 'long_context', confidence: 0.95, reason: longByTokens ? 'token estimate' : 'session fill' }
  }

  const lower = text.toLowerCase()
  if (CODE.test(lower) || CODE_FR.test(lower) || /```/.test(text)) {
    const fenced = /```/.test(text)
    const strong = CODE_STRONG.test(lower)
    const alsoOther = RESEARCH.test(lower) || WRITING.test(lower)
    let confidence = 0.58
    let reason = 'code keyword'
    if (fenced) {
      confidence = 0.95
      reason = 'fenced code'
    } else if (strong) {
      confidence = alsoOther ? 0.78 : 0.88
      reason = 'strong code keyword'
    } else if (alsoOther) {
      confidence = 0.42
      reason = 'weak code keyword, also other categories'
    }
    return { category: 'coding', confidence, reason }
  }
  if (RESEARCH.test(lower)) {
    const strong = RESEARCH_STRONG.test(lower)
    const alsoWriting = WRITING.test(lower)
    const confidence = strong ? (alsoWriting ? 0.72 : 0.85) : (alsoWriting ? 0.4 : 0.5)
    return { category: 'research', confidence, reason: strong ? 'strong research keyword' : 'weak research keyword' }
  }
  if (WRITING.test(lower)) {
    const strong = WRITING_STRONG.test(lower)
    return { category: 'writing', confidence: strong ? 0.85 : 0.5, reason: strong ? 'strong writing keyword' : 'weak writing keyword' }
  }

  const trimmed = text.trim()
  if (trimmed.length <= 140 && QUICK.test(trimmed) && !/```/.test(text)) {
    if (QUICK_STRONG.test(trimmed)) {
      return { category: 'quick', confidence: 0.9, reason: 'short courtesy' }
    }
    return { category: 'quick', confidence: 0.55, reason: 'short prompt' }
  }

  return { category: 'other', confidence: 0.3, reason: 'no rule matched' }
}

/**
 * @param {{ text: string, imageCount?: number, contextUsed?: number, contextMax?: number }} input
 */
export function classifyPrompt(input) {
  return classifyPromptWithConfidence(input).category
}
