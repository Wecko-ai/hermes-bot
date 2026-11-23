/** Readable name and provider of the model Auto picked: « GPT 5.6 Sol » and « Cursor ». */

const PROVIDERS: Record<string, string> = {
  cursor: 'Cursor', nvidia: 'NVIDIA', 'kimi-coding': 'Kimi', kimi: 'Kimi', moonshot: 'Kimi', moonshotai: 'Kimi',
  gemini: 'Gemini', google: 'Gemini', 'google-ai-studio': 'Gemini', aistudio: 'Gemini', openrouter: 'OpenRouter',
  omlx: 'Local', ollama: 'Local', local: 'Local', lmstudio: 'Local', 'llama-cpp': 'Local', mlx: 'Local',
  anthropic: 'Anthropic', openai: 'OpenAI', deepseek: 'DeepSeek', mistral: 'Mistral', groq: 'Groq',
}

const BRANDS: Record<string, string> = {
  gpt: 'GPT', claude: 'Claude', gemini: 'Gemini', gemma: 'Gemma', kimi: 'Kimi', glm: 'GLM', deepseek: 'DeepSeek',
  qwen: 'Qwen', minimax: 'MiniMax', llama: 'Llama', nemotron: 'Nemotron', composer: 'Composer', mistral: 'Mistral',
  grok: 'Grok', phi: 'Phi', vl: 'VL', ai: 'AI',
}

const DROPPED = new Set(['it', 'instruct', 'chat', 'hf', 'gguf'])

/** Provider shown after the model: from the routed id's first segment, else the label's parentheses. */
export function autoRouteProvider(chosen: string, label?: string) {
  const prefix = chosen.includes('/') ? chosen.split('/')[0].toLowerCase() : ''
  if (prefix && PROVIDERS[prefix]) return PROVIDERS[prefix]
  const inLabel = label?.match(/\(([^)]+)\)\s*$/)?.[1]?.trim()
  if (inLabel) return inLabel
  return prefix ? prefix.charAt(0).toUpperCase() + prefix.slice(1) : ''
}

function prettyToken(token: string) {
  const lower = token.toLowerCase()
  if (BRANDS[lower]) return BRANDS[lower]
  const branded = lower.match(/^([a-z]+)(\d[\w.]*)$/)
  if (branded && BRANDS[branded[1]]) return `${BRANDS[branded[1]]} ${branded[2].toUpperCase()}`
  if (/^\d+(\.\d+)?[bmk]$/i.test(token)) return token.toUpperCase()
  if (/^[a-z]\d[\d.]*$/i.test(token)) return token.toUpperCase()
  if (/^\d/.test(token)) return token
  return token.charAt(0).toUpperCase() + token.slice(1)
}

/** `cursor/cursor/claude-opus-5-5` → « Claude Opus 5.5 »; `nvidia/minimaxai/minimax-m3.1-flash` → « MiniMax M3.1 Flash ». */
export function prettyModelName(chosen: string) {
  let base = chosen.split('/').pop() || chosen
  if (base.includes('--')) base = base.split('--').pop() || base
  const tokens = base.split(/[-_\s]+/).filter((token) => token && !DROPPED.has(token.toLowerCase()) && !/^\d+bit$/i.test(token))
  const words: string[] = []
  for (const token of tokens) {
    // Version parts written with dashes: `5-5` → `5.5`.
    if (/^\d+$/.test(token) && words.length && /^\d+(\.\d+)*$/.test(words[words.length - 1])) {
      words[words.length - 1] += `.${token}`
      continue
    }
    words.push(prettyToken(token))
  }
  return words.join(' ') || base
}

/** Name from the table's label when there is one (« GPT-5.6 Sol (Cursor) » → « GPT 5.6 Sol »), else from the id. */
export function autoRouteModelName(chosen: string, label?: string) {
  if (!label?.trim()) return prettyModelName(chosen)
  let name = label.replace(/\s*\([^)]*\)\s*$/, '').trim()
  name = name.replace(/^GPT-(?=\d)/i, 'GPT ')
  if (autoRouteProvider(chosen, label) === 'Local') name = name.replace(/\s+local$/i, '')
  return name || prettyModelName(chosen)
}

/** « GPT 5.6 Sol · Cursor »: the provider is not repeated when the name already ends with it. */
export function autoRouteDisplay(chosen: string, label?: string) {
  const name = autoRouteModelName(chosen, label)
  const provider = autoRouteProvider(chosen, label)
  if (!provider || name.toLowerCase().endsWith(provider.toLowerCase())) return name
  return `${name} · ${provider}`
}
