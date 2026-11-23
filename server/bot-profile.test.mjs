import { describe, expect, it } from 'vitest'
import {
  diffLines, exportTemplate, importTemplateBody, sanitizeExport, toolsetsBody, toolsetsFromConfig,
} from './bot-profile.mjs'

describe('bot profile', () => {
  it('retire les secrets d’un export', () => {
    const clean = sanitizeExport({ model: { provider: 'x' }, env: { OPENAI_API_KEY: 'placeholder-value' } })
    expect(clean.env.OPENAI_API_KEY).toBe('[redacted]')
  })

  it('exporte un gabarit sans clés', () => {
    const payload = exportTemplate({
      slug: 'nova',
      soul: '# Soul',
      config: { model: { provider: 'p', default: 'm' }, toolsets: { enabled: ['web'] } },
      card: { title: 'Nova' },
    })
    expect(payload.version).toBe(1)
    expect(payload.config.model).toEqual({ provider: 'p', default: 'm' })
  })

  it('prépare un import', () => {
    const parsed = importTemplateBody({ soul: 'Hello', config: { toolsets: { enabled: ['web'] } } })
    expect(parsed.soul).toBe('Hello')
    expect(parsed.configBody.config.toolsets.enabled).toEqual(['web'])
  })

  it('calcule un diff ligne à ligne', () => {
    const lines = diffLines('a\nb', 'a\nc')
    expect(lines.filter((line) => line.kind !== 'same')).toHaveLength(2)
  })

  it('lit et écrit les toolsets', () => {
    expect(toolsetsFromConfig({ toolsets: { enabled: ['web'], disabled: ['places'] } })).toEqual({ enabled: ['web'], disabled: ['places'] })
    expect(toolsetsBody({ enabled: ['web', 'web'], disabled: [] })).toEqual({ config: { toolsets: { enabled: ['web'], disabled: [] } } })
  })
})
