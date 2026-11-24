import { describe, expect, it } from 'vitest'
import { CHEF_QWEN_MODEL_SENTINEL, CHEF_QWEN_PICKER_OPTION, chefQwenChip, isChefQwenModel } from './chef-qwen'
import { composerChipText } from './turn-model'
import { modelLabel } from './model'
import { pickerModelForSession } from './auto-router'

describe('Chef Qwen mode', () => {
  it('recognizes the sentinel only', () => {
    expect(isChefQwenModel(CHEF_QWEN_MODEL_SENTINEL)).toBe(true)
    expect(isChefQwenModel('hermesbot/chef-qwen')).toBe(true)
    expect(isChefQwenModel('hermesbot:auto')).toBe(false)
    expect(isChefQwenModel('mlx-community--Qwen3.8-27B-4bit')).toBe(false)
    expect(CHEF_QWEN_PICKER_OPTION.provider).toBe('hermesbot')
  })

  it('labels the sentinel « Chef Qwen »', () => {
    expect(modelLabel(CHEF_QWEN_MODEL_SENTINEL)).toBe('Chef Qwen')
  })

  it('chip shows the mode and the real chef model', () => {
    const chip = composerChipText({ answered: null, chatModel: CHEF_QWEN_MODEL_SENTINEL, fallbackMark: '(secours)', chefLabel: 'Chef Qwen' })
    expect(chip).toMatch(/^Chef Qwen · /)
    expect(chip).toMatch(/Cursor/)
    expect(chefQwenChip('Chef Qwen', '')).toBe('Chef Qwen')
  })

  it('a session already on Chef Qwen reopens on Chef Qwen even when Auto is the default', () => {
    expect(pickerModelForSession(undefined, CHEF_QWEN_MODEL_SENTINEL, { useAutoModel: true }, true)).toBe(CHEF_QWEN_MODEL_SENTINEL)
    // An explicit Auto pick made after it wins (the gateway session is switched on the next send).
    expect(pickerModelForSession('hermesbot:auto', CHEF_QWEN_MODEL_SENTINEL, { useAutoModel: true }, true)).toBe('hermesbot:auto')
    expect(pickerModelForSession(undefined, 'cursor/grok-4.7', { useAutoModel: true }, true)).toBe('hermesbot:auto')
  })
})
