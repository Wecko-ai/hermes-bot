import { describe, expect, it, vi } from 'vitest'
import { installSkillFromHub } from './skills'
import type { HermesClient } from './hermes'

describe('skills hub', () => {
  it('calls skills.manage install on explicit request', async () => {
    const request = vi.fn(async () => ({ installed: true, name: 'web/demo' }))
    const client = { request } as unknown as HermesClient
    const result = await installSkillFromHub(client, 'orion', 'web/demo')
    expect(request).toHaveBeenCalledWith('skills.manage', { profile: 'orion', action: 'install', query: 'web/demo' })
    expect(result.installed).toBe(true)
  })
})