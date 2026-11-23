import { describe, expect, it } from 'vitest'
import { isSafeModelId } from './model-id.mjs'

describe('model id charset', () => {
  it('allows provider/model, :free and Cloudflare @cf ids', () => {
    expect(isSafeModelId('nvidia/z-ai/glm-5.3')).toBe(true)
    expect(isSafeModelId('openrouter/z-ai/glm-5.2:free')).toBe(true)
    expect(isSafeModelId('openrouter/openrouter/free')).toBe(true)
    expect(isSafeModelId('sambanova/gemma-4-31B-it')).toBe(true)
    expect(isSafeModelId('cloudflare/@cf/meta/llama-3.1-8b-instruct-fp8-fast')).toBe(true)
    expect(isSafeModelId('@cf/meta/llama-3.3-70b-instruct-fp8-fast')).toBe(true)
    expect(isSafeModelId('custom:omlx/qwen-local')).toBe(true)
  })

  it('rejects traversal, whitespace, shell metacharacters and over-long ids', () => {
    expect(isSafeModelId('cursor/../x')).toBe(false)
    expect(isSafeModelId('foo/../../etc/passwd')).toBe(false)
    expect(isSafeModelId('cursor/../x y')).toBe(false)
    expect(isSafeModelId('model name')).toBe(false)
    expect(isSafeModelId('model;rm')).toBe(false)
    expect(isSafeModelId('model|id')).toBe(false)
    expect(isSafeModelId('$(id)')).toBe(false)
    expect(isSafeModelId('`id`')).toBe(false)
    expect(isSafeModelId("model'x")).toBe(false)
    expect(isSafeModelId('model"x')).toBe(false)
    expect(isSafeModelId('/etc/passwd')).toBe(false)
    expect(isSafeModelId('')).toBe(false)
    expect(isSafeModelId('a'.repeat(200))).toBe(true)
    expect(isSafeModelId('a'.repeat(201))).toBe(false)
    expect(isSafeModelId('model\nname')).toBe(false)
  })
})
