// Official logos copied from @lobehub/icons-static-svg 1.102.0 (MIT), see src/assets/providers/README.md.
const LOGOS = import.meta.glob<string>('../assets/providers/*.svg', { eager: true, query: '?url', import: 'default' })

export const LOCAL_GROUP = 'local-llm'

export interface ProviderBrand {
  group: string
  name: string
  local: boolean
  logo?: string
}

// Servers running on this machine. opencodex and LiteLLM also listen locally, but serve remote models.
const LOCAL_SERVER = /(?:^|[^a-z])(?:local|localhost|omlx|mlx|ollama|lm[- ]?studio|llama[.-]?cpp|vllm)(?:[^a-z]|$)/

// Order matters: the first brand recognized in the slug or the name wins.
const BRANDS: Array<[RegExp, string]> = [
  [/anthropic|claude/, 'anthropic'],
  [/openrouter/, 'openrouter-color'],
  [/openai|chatgpt|codex/, 'openai'],
  [/copilot/, 'githubcopilot'],
  [/\bnous\b/, 'nousresearch'],
  [/kimi|moonshot/, 'kimi-color'],
  [/deepseek/, 'deepseek-color'],
  [/deepinfra/, 'deepinfra-color'],
  [/qwen/, 'qwen-color'],
  [/alibaba/, 'alibaba-color'],
  [/\bxai\b|grok/, 'xai'],
  [/vertex/, 'vertexai-color'],
  [/gemini|google/, 'gemini-color'],
  [/\bzai\b|z\.ai|glm/, 'zai'],
  [/minimax/, 'minimax-color'],
  [/stepfun/, 'stepfun-color'],
  [/fireworks/, 'fireworks-color'],
  [/novita/, 'novita-color'],
  [/xiaomi/, 'xiaomimimo'],
  [/tencent/, 'tencent-color'],
  [/nvidia/, 'nvidia-color'],
  [/hugging ?face/, 'huggingface-color'],
  [/arcee/, 'arcee-color'],
  [/kilo ?code/, 'kilocode'],
  [/opencode/, 'opencode'],
  [/bedrock/, 'bedrock-color'],
  [/azure/, 'azureai-color'],
  [/vercel/, 'vercel'],
  [/\bmeta\b/, 'meta-color'],
  [/nebius/, 'nebius'],
  [/upstage/, 'upstage-color'],
  [/ollama/, 'ollama'],
]

/** All local servers form a single “Local LLM” group; the real provider stays in the option sent to Hermes. */
export function providerBrand(slug: string, name: string): ProviderBrand {
  const text = `${slug} ${name}`.toLocaleLowerCase('en')
  if (LOCAL_SERVER.test(text) && !text.includes('cloud')) return { group: LOCAL_GROUP, name: 'Local LLM', local: true }
  const file = BRANDS.find(([pattern]) => pattern.test(text))?.[1]
  return { group: slug, name, local: false, logo: file ? LOGOS[`../assets/providers/${file}.svg`] : undefined }
}
