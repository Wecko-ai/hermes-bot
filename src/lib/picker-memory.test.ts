import { afterEach, describe, expect, it } from 'vitest'
import { clearPickerMemory, pickerForSession, readPickerMemory, writePickerForSession } from './picker-memory'
import { AUTO_MODEL_SENTINEL } from './auto-router'

describe('picker memory', () => {
  afterEach(() => {
    clearPickerMemory()
  })

  it('remembers Auto and an explicit model per session', () => {
    writePickerForSession('s1', AUTO_MODEL_SENTINEL)
    writePickerForSession('s2', 'kimi-for-coding')
    expect(pickerForSession('s1')).toBe(AUTO_MODEL_SENTINEL)
    expect(pickerForSession('s2')).toBe('kimi-for-coding')
    expect(pickerForSession('missing')).toBeUndefined()
    expect(pickerForSession(undefined)).toBeUndefined()
  })

  it('keeps the newest 200 sessions', () => {
    for (let i = 0; i < 201; i += 1) writePickerForSession(`s${i}`, `m${i}`)
    const memory = readPickerMemory()
    expect(Object.keys(memory)).toHaveLength(200)
    expect(memory.s0).toBeUndefined()
    expect(memory.s200).toBe('m200')
    expect(memory.s1).toBe('m1')
  })
})
