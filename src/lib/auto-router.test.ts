import { describe, expect, it, vi, afterEach } from 'vitest'
import { AUTO_FREE_MODEL_SENTINEL, AUTO_MODEL_SENTINEL, autoModeFor, defaultAutoPicker, isAutoModel, pickerModelAfterRoute, pickerModelForSession } from './auto-router'

describe('auto-router client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('detects auto sentinel', () => {
    expect(isAutoModel(AUTO_MODEL_SENTINEL)).toBe(true)
    expect(isAutoModel('kimi-for-coding')).toBe(false)
  })

  it('tells Auto and Auto gratuit apart', () => {
    expect(isAutoModel(AUTO_FREE_MODEL_SENTINEL)).toBe(true)
    expect(autoModeFor(AUTO_FREE_MODEL_SENTINEL, {})).toBe('auto-free')
    expect(autoModeFor(AUTO_MODEL_SENTINEL, { useAutoFreeModel: true })).toBe('auto')
    expect(autoModeFor('kimi-for-coding', { useAutoFreeModel: true })).toBeNull()
    expect(autoModeFor('kimi-for-coding', { useAutoModel: true })).toBeNull()
    expect(autoModeFor('kimi-for-coding', {})).toBeNull()
    expect(autoModeFor('', { useAutoModel: true })).toBe('auto')
    expect(autoModeFor(undefined, { useAutoFreeModel: true })).toBe('auto-free')
  })

  it('keeps Auto on the picker after routing', () => {
    expect(pickerModelAfterRoute(AUTO_MODEL_SENTINEL, 'kimi-for-coding')).toBe(AUTO_MODEL_SENTINEL)
    expect(pickerModelAfterRoute(AUTO_FREE_MODEL_SENTINEL, 'gemma-local')).toBe(AUTO_FREE_MODEL_SENTINEL)
    expect(pickerModelAfterRoute('claude-sonnet-5-5', 'kimi-for-coding')).toBe('kimi-for-coding')
    expect(pickerModelForSession(AUTO_MODEL_SENTINEL, 'kimi-for-coding')).toBe(AUTO_MODEL_SENTINEL)
    expect(pickerModelForSession('claude-sonnet-5-5', 'kimi-for-coding')).toBe('claude-sonnet-5-5')
    expect(pickerModelForSession(undefined, 'kimi-for-coding', { useAutoModel: false }, false)).toBe('kimi-for-coding')
    expect(pickerModelForSession(undefined, 'kimi-for-coding', { useAutoModel: true }, true)).toBe(AUTO_MODEL_SENTINEL)
    expect(pickerModelForSession(undefined, 'kimi-for-coding', { useAutoFreeModel: true }, true)).toBe(AUTO_FREE_MODEL_SENTINEL)
  })

  it('defaults the picker to Auto when the router is on', () => {
    expect(defaultAutoPicker({ useAutoModel: true }, true)).toBe(AUTO_MODEL_SENTINEL)
    expect(defaultAutoPicker({ useAutoModel: true }, false)).toBe('')
    expect(defaultAutoPicker({ useAutoModel: false }, true)).toBe('')
    expect(defaultAutoPicker({ useAutoFreeModel: true, useAutoModel: true }, true)).toBe(AUTO_FREE_MODEL_SENTINEL)
  })
})
