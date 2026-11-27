import { describe, expect, it } from 'vitest'
import { modelMatchKey, prettyModelName } from './model-names'
import { modelLabel } from './model'

// Real ids from the Hermes catalogs, the profiles and `providers.cursor.models`.
const CASES: Array<[string, string]> = [
  ['gemini-3.5-flash', 'Gemini 3.5 Flash'],
  ['gemini-3.5-flash-lite@eu', 'Gemini 3.5 Flash Lite'],
  ['gemini-3-8-flash', 'Gemini 3.8 Flash'],
  ['gemini-3.1-pro', 'Gemini 3.1 Pro'],
  ['cursor/gemini-3.1-pro', 'Gemini 3.1 Pro'],
  ['gemini-3.1-flash-image-preview', 'Gemini 3.1 Flash Image Preview'],
  ['gemini-pro-latest', 'Gemini Pro Latest'],
  ['gemini-4-carbon', 'Gemini 4 Carbon'],
  ['vertex/gemini-4-hydrogen@eu', 'Gemini 4 Hydrogen'],
  ['gpt-5.6-sol', 'GPT 5.6 Sol'],
  ['gpt-5.6-luna', 'GPT 5.6 Luna'],
  ['gpt-5.6-sol-high', 'GPT 5.6 Sol High'],
  ['gpt-6.1-sol', 'GPT 6.1 Sol'],
  ['cursor/gpt-5.6-terra', 'GPT 5.6 Terra'],
  ['gpt-6-luna', 'GPT 6 Luna'],
  ['openai/gpt-6.1-terra-pro', 'GPT 6.1 Terra Pro'],
  ['gpt-5.5', 'GPT 5.5'],
  ['gpt-5-3-codex', 'GPT 5.3 Codex'],
  ['gpt-5-nano', 'GPT 5 Nano'],
  ['gpt-oss:20b', 'GPT OSS 20B'],
  ['openai/o3', 'o3'],
  ['o3-pro', 'o3 Pro'],
  ['deepseek/deepseek-v4-flash-0731', 'DeepSeek V4 Flash'],
  ['deepseek-v4-1-flash-1017', 'DeepSeek V4.1 Flash'],
  ['deepseek-v4-pro:free', 'DeepSeek V4 Pro'],
  ['deepseek-ai/DeepSeek-V3-0324', 'DeepSeek V3'],
  ['deepseek-v4.1-flash-latest', 'DeepSeek V4.1 Flash Latest'],
  ['kimi-k3', 'Kimi K3'],
  ['k3.1-pro', 'K3.1 Pro'],
  ['kimi-k2.8', 'Kimi K2.8'],
  ['kimi-k2.7-code', 'Kimi K2.7 Code'],
  ['kimi-for-coding', 'Kimi K2.8 Preview'],
  ['kimi-coding/kimi-for-coding', 'Kimi K2.8 Preview'],
  ['kimi-k2-0905-preview', 'Kimi K2 Preview'],
  ['qwen3.8:27b', 'Qwen 3.8 27B'],
  ['mlx-community--Qwen3.8-27B-4bit', 'Qwen 3.8 27B'],
  ['qwen3.8-max', 'Qwen 3.8 Max'],
  ['qwen3-235b-a22b', 'Qwen 3 235B A22B'],
  ['qwen/qwen3.5-397b-a17b:thinking', 'Qwen 3.5 397B A17B Thinking'],
  ['qwen3-max-2025-09-23', 'Qwen 3 Max'],
  ['glm-5.2', 'GLM 5.2'],
  ['glm-5-2-260617', 'GLM 5.2'],
  ['glm-5.3-flash', 'GLM 5.3 Flash'],
  ['zai-org/GLM-5.2-Fast', 'GLM 5.2 Fast'],
  ['cursor/glm-5.3', 'GLM 5.3'],
  ['grok-4.7', 'Grok 4.7'],
  ['xai/grok-code-fast-1', 'Grok Code Fast 1'],
  ['grok-4.20-non-reasoning', 'Grok 4.20 Non-reasoning'],
  ['mistral-large-4', 'Mistral Large 4'],
  ['mistral/mistral-medium-2604', 'Mistral Medium'],
  ['mistral/codestral', 'Codestral'],
  ['llama-3.1-8b-instruct', 'Llama 3.1 8B Instruct'],
  ['llama-4-scout', 'Llama 4 Scout'],
  ['nemotron-3-super-120b-a12b-free', 'Nemotron 3 Super 120B A12B'],
  ['nvidia/Nemotron-3-Nano-30B-A3B', 'Nemotron 3 Nano 30B A3B'],
  ['minimax-m3', 'MiniMax M3'],
  ['minimax/minimax-m2.1-lightning', 'MiniMax M2.1 Lightning'],
  ['mimo-v2.5-pro', 'MiMo V2.5 Pro'],
  ['cursor/composer-2.5', 'Composer 2.5'],
  ['cursor/auto', 'Auto'],
  ['gemma-4-31b-it', 'Gemma 4 31B IT'],
  ['step-5-preview-free', 'Step 5 Preview'],
  ['global.anthropic.claude-haiku-4-5-20251001-v1:0', 'Claude Haiku 4.5'],
  ['meta.llama4-maverick-17b-instruct-v1:0', 'Llama 4 Maverick 17B Instruct'],
  ['~deepseek/deepseek-flash-latest', 'DeepSeek Flash Latest'],
]

describe('prettyModelName', () => {
  it.each(CASES)('%s -> %s', (id, expected) => {
    expect(prettyModelName(id)).toBe(expected)
  })

  it('keeps the raw id when the shape is unknown or unsafe', () => {
    expect(prettyModelName('5.5')).toBe('5.5')
    expect(prettyModelName('weird id with spaces')).toBe('weird id with spaces')
    expect(prettyModelName('')).toBe('')
  })

  it('keeps Claude names as they were', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelLabel('claude-opus-4-20250514')).toBe('Opus 4')
    expect(modelLabel('au.anthropic.claude-haiku-5-5')).toBe('Haiku 5.5')
    expect(modelLabel('openrouter/anthropic/claude-sonnet-5.5')).toBe('Sonnet 5.5')
    expect(modelLabel('claude-sonnet-5.5')).toBe('Sonnet 5.5')
    expect(prettyModelName('claude-sonnet-5.5')).toBe('Claude Sonnet 5.5')
    expect(prettyModelName('kimi-k2.8')).toBe('Kimi K2.8')
  })
})

describe('modelMatchKey', () => {
  it('gives one key to the spellings of the same model', () => {
    expect(modelMatchKey('gemini-3.5-flash')).toBe(modelMatchKey('google/gemini-3-5-flash-20260101'))
    expect(modelMatchKey('gpt-6.1-sol')).toBe(modelMatchKey('openai/gpt-6-1-sol'))
    expect(modelMatchKey('gpt-6.1-sol')).not.toBe(modelMatchKey('gpt-6.1-sol-pro'))
    expect(modelMatchKey('gemini-3.5-flash')).not.toBe(modelMatchKey('gemini-3.5-pro'))
    expect(modelMatchKey('qwen3.8:27b')).toBe(modelMatchKey('qwen3-8-27b'.replace('3-8', '3.8')))
  })
})

describe('prettyModelName quantization suffixes', () => {
  it('documents how retired quantization suffixes format if ever seen', () => {
    // Local servers prune absent ids from picker memory; these are fallbacks.
    expect(prettyModelName('kimi-for-coding')).toBe('Kimi K2.8 Preview')
    expect(prettyModelName('Inkling-2-Mini-128K')).toBe('Inkling 2 Mini 128K')
    expect(prettyModelName('Inkling-2-Mini-256K')).toBe('Inkling 2 Mini 256K')
    expect(prettyModelName('Inkling-2-Mini-oQ4e-mtp')).toBe('Inkling 2 Mini Oq4e Mtp')
  })
})
