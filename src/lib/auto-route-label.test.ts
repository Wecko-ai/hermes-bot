import { describe, expect, it } from 'vitest'
import { autoRouteDisplay, autoRouteProvider, prettyModelName } from './auto-route-label'

describe('auto route label', () => {
  it('uses the table label without repeating its provider', () => {
    expect(autoRouteDisplay('cursor/cursor/gpt-5.6-sol', 'GPT-5.6 Sol (Cursor)')).toBe('GPT 5.6 Sol · Cursor')
    expect(autoRouteDisplay('nvidia/minimaxai/minimax-m3.1-flash', 'MiniMax M3.1 Flash (NVIDIA)')).toBe('MiniMax M3.1 Flash · NVIDIA')
    expect(autoRouteDisplay('kimi-coding/kimi-for-coding', 'Kimi K2.8 Preview')).toBe('Kimi K2.8 Preview · Kimi')
    expect(autoRouteDisplay('gemini/gemini-3.8-flash', 'Gemini 3.8 Flash (AI Studio)')).toBe('Gemini 3.8 Flash · Gemini')
    expect(autoRouteDisplay('omlx/mlx-community--Qwen3.8-27B-4bit', 'Qwen 3.8 27B local (oMLX)')).toBe('Qwen 3.8 27B · Local')
  })

  it('prettifies an id with no label', () => {
    expect(autoRouteDisplay('cursor/cursor/gpt-5.6-sol')).toBe('GPT 5.6 Sol · Cursor')
    expect(prettyModelName('cursor/cursor/claude-opus-5-5')).toBe('Claude Opus 5.5')
    expect(prettyModelName('nvidia/z-ai/glm-5.3-flash')).toBe('GLM 5.3 Flash')
    expect(prettyModelName('nvidia/deepseek-ai/deepseek-v4.1-flash')).toBe('DeepSeek V4.1 Flash')
    expect(prettyModelName('omlx/mlx-community--Qwen3.8-27B-4bit')).toBe('Qwen 3.8 27B')
    expect(prettyModelName('nvidia/google/gemma-4-31b-it')).toBe('Gemma 4 31B')
    expect(autoRouteDisplay('openrouter/qwen/qwen3.8-coder')).toBe('Qwen 3.8 Coder · OpenRouter')
    expect(autoRouteDisplay('ollama/llama3.3')).toBe('Llama 3.3 · Local')
  })

  it('derives the provider from the id prefix, else the label', () => {
    expect(autoRouteProvider('google/gemini-3.1-pro')).toBe('Gemini')
    expect(autoRouteProvider('acme/x', 'X (Acme Cloud)')).toBe('Acme Cloud')
    expect(autoRouteProvider('plain-model')).toBe('')
  })
})
