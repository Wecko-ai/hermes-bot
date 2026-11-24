import { describe, expect, it } from 'vitest'
import { formatModelOptionName, LOCAL_GROUP, localServerLabel, providerBrand } from './providers'

describe('logos des fournisseurs', () => {
  // Third column: the title embedded in the SVG, since Vite ships small logos as data: URLs (“upsate”: a typo in the pack).
  it.each([
    ['anthropic', 'Anthropic', 'anthropic'],
    ['openrouter', 'OpenRouter', 'openrouter'],
    ['openai-codex', 'ChatGPT or Codex Subscription', 'openai'],
    ['openai-api', 'OpenAI API', 'openai'],
    ['custom:opencodex', 'ChatGPT abo (opencodex)', 'openai'],
    ['cursor', 'Cursor (opencodex)', 'cursor'],
    ['copilot', 'GitHub Copilot', 'githubcopilot'],
    ['nous', 'Nous Portal', 'nousresearch'],
    ['kimi-coding', 'Kimi / Kimi Coding Plan', 'kimi'],
    ['deepseek', 'DeepSeek', 'deepseek'],
    ['deepinfra', 'DeepInfra', 'deepinfra'],
    ['alibaba', 'Qwen Cloud', 'qwen'],
    ['alibaba-cn', 'Alibaba Cloud DashScope (China)', 'alibaba'],
    ['xai-oauth', 'xAI Grok OAuth (SuperGrok / Premium+)', 'grok'],
    ['vertex', 'Google Vertex AI', 'vertexai'],
    ['gemini', 'Google AI Studio', 'gemini'],
    ['zai', 'Z.AI / GLM', 'z.ai'],
    ['minimax-cn', 'MiniMax (China)', 'minimax'],
    ['stepfun', 'StepFun Step Plan', 'stepfun'],
    ['fireworks', 'Fireworks AI', 'fireworks'],
    ['novita', 'NovitaAI', 'novita'],
    ['xiaomi', 'Xiaomi MiMo', 'xiaomimimo'],
    ['tencent-tokenhub', 'Tencent TokenHub', 'tencent'],
    ['nvidia', 'NVIDIA NIM', 'nvidia'],
    ['huggingface', 'Hugging Face', 'huggingface'],
    ['arcee', 'Arcee AI', 'arcee'],
    ['kilocode', 'Kilo Code', 'kilo code'],
    ['opencode-zen', 'OpenCode Zen', 'opencode'],
    ['bedrock', 'AWS Bedrock', 'bedrock'],
    ['azure-foundry', 'Azure Foundry', 'azureai'],
    ['ai-gateway', 'Vercel AI Gateway', 'vercel'],
    ['meta-ai', 'Meta Model API', 'meta'],
    ['nebius-token-factory', 'Nebius Token Factory', 'nebius'],
    ['upstage', 'Upstage Solar', 'upsate'],
    ['ollama-cloud', 'Ollama Cloud', 'ollama'],
  ])('%s garde son nom et son logo', (slug, name, title) => {
    const brand = providerBrand(slug, name)
    expect(brand).toMatchObject({ group: slug, name, local: false })
    expect(decodeURIComponent(brand.logo ?? '').toLowerCase()).toContain(title)
  })

  it.each([
    ['custom:omlx', 'Qwen local (oMLX)'],
    ['custom:splash', 'Local Splash Server'],
    ['lmstudio', 'LM Studio'],
    ['custom:ollama', 'Ollama'],
    ['llamacpp', 'llama.cpp'],
  ])('%s passe sous Local LLM, sans logo de marque', (slug, name) => {
    expect(providerBrand(slug, name)).toEqual({ group: LOCAL_GROUP, name: 'Local LLM', local: true })
  })

  it('n’invente pas de logo pour un fournisseur inconnu', () => {
    expect(providerBrand('moa', 'Mixture of Agents')).toEqual({ group: 'moa', name: 'Mixture of Agents', local: false, logo: undefined })
  })

  it('préfixe les modèles locaux avec le nom du serveur', () => {
    expect(localServerLabel('custom:omlx', 'Qwen local (oMLX)')).toBe('oMLX')
    expect(localServerLabel('custom:splash', 'Local Splash Server')).toBe('Splash')
    expect(localServerLabel('ollama', 'Ollama')).toBe('Ollama')
    expect(localServerLabel('anthropic', 'Anthropic')).toBe('')
    expect(formatModelOptionName({ provider: 'custom:omlx', providerName: 'oMLX' }, 'Qwen 3.8 27B')).toBe('oMLX / Qwen 3.8 27B')
    expect(formatModelOptionName({ provider: 'anthropic', providerName: 'Anthropic' }, 'Claude Sonnet 5.5')).toBe('Claude Sonnet 5.5')
  })
})
