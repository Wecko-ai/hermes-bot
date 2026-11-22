import { describe, expect, it } from 'vitest'
import { canConnect, connectSteps, countStatuses, demoConnectors, missingEnv, overlayProbes, waitForGrant, type Connector } from './connectors'
import type { Bot } from '../types'

const bot = (slug: string): Bot => ({
  slug, name: slug, role: '', section: '', sectionId: '', model: '',
  status: 'idle', unread: 0, preview: '', timestamp: null, hidden: false,
})

const harbor: Connector = {
  name: 'harbor', description: 'Mail', authType: 'oauth', transport: 'http', endpoint: 'mcp.example.test',
  requiredEnv: [{ name: 'HARBOR_TOKEN', prompt: 'Token', required: true }], postInstall: '',
  bots: [
    { profile: 'nova', installed: false, enabled: false, status: 'available', error: '' },
    { profile: 'orion', installed: true, enabled: true, status: 'needs_auth', error: '' },
  ],
}

describe('connectors', () => {
  it('plans a connect without a credential and counts each bot', () => {
    expect(connectSteps(harbor, 'nova')).toEqual(['install', 'oauth'])
    expect(connectSteps(harbor, 'orion')).toEqual(['oauth'])
    expect(canConnect(harbor, 'orion')).toBe(true)
    expect(missingEnv(harbor, {})).toEqual(['HARBOR_TOKEN'])
    expect(missingEnv(harbor, { HARBOR_TOKEN: 'typed-once' })).toEqual([])
    const overlaid = overlayProbes(harbor ? [harbor] : [], { orion: { harbor: { status: 'connected', error: '' } } })
    expect(overlaid[0].bots[1].status).toBe('connected')
    expect(countStatuses(overlaid[0].bots).connected).toBe(1)
    expect(JSON.stringify(connectSteps(harbor, 'nova'))).not.toContain('typed-once')
  })

  it('waits until Hermes finishes the sign-in and stops when the view closes', async () => {
    const seen: string[] = []
    const granted = await waitForGrant(async (flowId) => {
      seen.push(flowId)
      return seen.length > 1 ? { status: 'approved', error: '' } : { status: 'authorization_required', error: '' }
    }, 'flow-1', { wait: async () => {}, attempts: 5 })
    expect(granted.status).toBe('approved')
    const stopped = await waitForGrant(async () => ({ status: 'authorization_required', error: '' }), 'flow-2', {
      wait: async () => {}, attempts: 5, aborted: () => true,
    })
    expect(stopped.status).toBe('error')
  })

  it('builds a fictional catalog with no secret in it', () => {
    const entries = demoConnectors([bot('nova'), bot('orion'), bot('local:ollama')])
    expect(entries[0].bots.map((item) => item.profile)).toEqual(['nova', 'orion'])
    expect(entries[0].bots.find((item) => item.profile === 'orion')?.status).toBe('needs_auth')
    expect(JSON.stringify(entries)).not.toMatch(/token|secret|password/i)
  })
})
