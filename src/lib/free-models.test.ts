import { describe, expect, it } from 'vitest'
import { isFreeModel, isPaidOptIn, modelCost } from './free-models'

const free = (provider: string, model: string, providerName = provider, extra: { free?: boolean } = {}) => isFreeModel({ provider, model, providerName, ...extra })

describe('modèles gratuits', () => {
  it('reconnaît les variantes gratuites et le routeur gratuit d’OpenRouter', () => {
    expect(free('openrouter', 'nvidia/nemotron-3-ultra-550b-a55b:free')).toBe(true)
    expect(free('openrouter', 'openrouter/free')).toBe(true)
    expect(free('openrouter', 'anthropic/claude-opus-5.5')).toBe(false)
  })

  it('croit le prix gratuit donné par la gateway', () => {
    expect(free('nous', 'some-model', 'Nous Portal', { free: true })).toBe(true)
    expect(free('nous', 'some-model', 'Nous Portal', { free: false })).toBe(false)
  })

  it('garde tout le catalogue NVIDIA', () => {
    expect(free('nvidia', 'moonshotai/kimi-k3.1-pro')).toBe(true)
  })

  it('garde SambaNova et les ids Cloudflare Workers AI', () => {
    expect(free('sambanova', 'gemma-4-31B-it')).toBe(true)
    expect(free('cloudflare', '@cf/meta/llama-3.1-8b-instruct-fp8-fast')).toBe(true)
    expect(free('workers-ai', '@cf/meta/llama-3.3-70b-instruct-fp8-fast')).toBe(true)
    expect(free('other', '@cf/meta/llama-3.1-8b-instruct-fp8-fast')).toBe(true)
    expect(free('openrouter', 'meta/llama-3.1-8b')).toBe(false)
  })

  it('ne garde de Gemini que ce que le palier gratuit sert', () => {
    for (const model of ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-4-hydrogen']) expect(free('gemini', model)).toBe(true)
    for (const model of ['gemini-3.1-pro-preview', 'gemini-pro-latest', 'gemini-4-carbon', 'gemini-4-argon', 'gemini-omni-flash-preview']) expect(free('gemini', model)).toBe(false)
    // The same model through a paid route is not free.
    expect(free('openrouter', 'google/gemini-3.8-flash')).toBe(false)
    expect(free('vertex', 'gemini-3.8-flash', 'Vertex AI')).toBe(false)
  })

  it('compte les modèles locaux, pas les abonnements', () => {
    expect(free('custom:omlx', 'qwen-local-27b', 'Qwen local (oMLX)')).toBe(true)
    expect(free('lmstudio', 'gemma-local', 'LM Studio')).toBe(true)
    expect(free('ollama-cloud', 'kimi-k3', 'Ollama Cloud')).toBe(false)
    expect(free('custom:cursor', 'cursor/claude-sonnet-5-5', 'Cursor (abo)')).toBe(false)
    expect(free('anthropic', 'claude-opus-5-5', 'Anthropic')).toBe(false)
  })

  it('compte les abonnements déclarés comme sans frais en plus, gratuits d’abord', () => {
    const subscriptions = ['anthropic', 'cursor', 'kimi-coding']
    expect(modelCost({ provider: 'anthropic', model: 'claude-opus-5-5', providerName: 'Anthropic' }, subscriptions)).toBe('subscription')
    expect(modelCost({ provider: 'cursor', model: 'cursor/composer-2.5', providerName: 'Cursor (abo)' }, subscriptions)).toBe('subscription')
    expect(modelCost({ provider: 'openrouter', model: 'anthropic/claude-opus-5.5', providerName: 'OpenRouter' }, subscriptions)).toBe('paid')
    expect(modelCost({ provider: 'gemini', model: 'gemini-3.5-flash', providerName: 'Google' }, subscriptions)).toBe('free')
    expect(modelCost({ provider: 'anthropic', model: 'claude-opus-5-5', providerName: 'Anthropic' }, [])).toBe('paid')
  })

  it('Hy4 Flash est un modèle payant à choisir exprès, sur le fournisseur dédié seulement', () => {
    const hy4 = { provider: 'custom:openrouter-hermesbot', model: 'tencent/hy4-flash', providerName: 'Hy4 Flash (OpenRouter, payant)' }
    expect(isPaidOptIn(hy4)).toBe(true)
    expect(modelCost(hy4, ['kimi-coding'])).toBe('paid')
    expect(isPaidOptIn({ provider: 'openrouter', model: 'tencent/hy4-flash' })).toBe(false)
    expect(isPaidOptIn({ provider: 'custom:openrouter-hermesbot', model: 'tencent/hy4' })).toBe(false)
  })
})
