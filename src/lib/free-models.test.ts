import { describe, expect, it } from 'vitest'
import { isFreeModel } from './free-models'

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
})
