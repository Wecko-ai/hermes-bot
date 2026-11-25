import { describe, expect, it } from 'vitest'
import type { ModelOption } from '../types'
import { groupModels } from './ModelPicker'
import { LOCAL_GROUP } from '../lib/providers'

const option = (provider: string, providerName: string, model: string): ModelOption => ({
  model, provider, providerName,
})

describe('groupModels', () => {
  it('puts Local LLM first, then keeps the other providers in catalog order', () => {
    const groups = groupModels([
      option('kimi-coding', 'Kimi / Moonshot', 'kimi-for-coding'),
      option('cursor', 'Cursor (abo)', 'cursor/grok-4.7'),
      option('splash', 'Inkling 2 Mini (Splash)', 'Inkling-2-Mini-128K'),
      option('splash-uncensored', 'Inkling 2 Mini Uncensored (Splash)', 'Inkling-2-Mini-Uncensored-128K'),
      option('nvidia', 'NVIDIA NIM', 'nvidia/nemotron-3-super-120b-a12b'),
    ])
    expect(groups[0]?.slug).toBe(LOCAL_GROUP)
    expect(groups[0]?.name).toBe('Local LLM')
    expect(groups[0]?.models.map((item) => item.model)).toEqual([
      'Inkling-2-Mini-128K',
      'Inkling-2-Mini-Uncensored-128K',
    ])
    expect(groups.map((group) => group.slug)).toEqual([LOCAL_GROUP, 'kimi-coding', 'cursor', 'nvidia'])
  })

  it('keeps Cursor models out of the Kimi group', () => {
    const groups = groupModels([
      option('kimi-coding', 'Kimi / Moonshot', 'kimi-for-coding'),
      option('cursor', 'Cursor (abo)', 'cursor/grok-4.7'),
    ])
    const kimi = groups.find((group) => group.slug === 'kimi-coding')
    expect(kimi?.models.map((item) => item.model)).toEqual(['kimi-for-coding'])
    expect(groups.find((group) => group.slug === 'cursor')?.models.map((item) => item.model)).toEqual(['cursor/grok-4.7'])
  })
})
