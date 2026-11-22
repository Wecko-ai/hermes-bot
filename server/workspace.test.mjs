import { describe, expect, it } from 'vitest'
import { SHARED_MARKER, TYPE_FILES } from './shared-memory.mjs'
import { createWorkspace } from './workspace.mjs'

function gateway() {
  const files = new Map()
  const configs = new Map()
  const calls = []
  return {
    calls,
    files,
    configs,
    async readText(file) {
      return files.has(file) ? { status: 200, text: files.get(file) } : { status: 404, text: '' }
    },
    async writeText(file, content) {
      files.set(file, content)
      return { ok: true, status: 200 }
    },
    async readConfig(profile) {
      if (!configs.has(profile)) throw new Error('missing')
      return structuredClone(configs.get(profile))
    },
    async writeConfig(profile, body) {
      const current = configs.get(profile) || {}
      const skills = body.config?.skills ? { ...current.skills, ...body.config.skills } : current.skills
      const model = body.config?.model ? { ...current.model, ...body.config.model } : current.model
      configs.set(profile, { ...current, ...(skills ? { skills } : {}), ...(model ? { model } : {}), ...strip(body.config) })
    },
    async request(method, route, body) {
      calls.push({ method, route, body })
      if (route.startsWith('/api/skills?')) return { status: 404, body: null }
      if (route.startsWith('/api/skills/toggle')) return { status: 404, body: null }
      if (route.startsWith('/api/skills/hub/search')) return { status: 404, body: null }
      if (route.startsWith('/api/skills/hub/install')) return { status: 404, body: null }
      if (route.startsWith('/api/memory')) return { status: 200, body: { provider: 'hindsight' } }
      if (route.includes('/soul') && method === 'GET') return { status: 404, body: null }
      if (route.includes('/soul') && method === 'PUT') return { status: 404, body: null }
      if (route.includes('/model') && method === 'PUT') return { status: 404, body: null }
      if (route.startsWith('/api/model/set')) return { status: 404, body: null }
      if (route.startsWith('/api/tools/toolsets?')) return { status: 200, body: [{ name: 'web', label: 'Web', description: 'Search', enabled: true, tools: ['web_search'] }] }
      if (route.startsWith('/api/tools/toolsets/')) return { status: 200, body: { ok: true } }
      return { status: 500, body: null }
    },
  }
}

function strip(config) {
  if (!config) return {}
  const { skills, model, ...rest } = config
  return rest
}

describe('workspace against an older gateway', () => {
  it('stores a shared fact, makes it visible to every profile, and can forget it', async () => {
    const gw = gateway()
    gw.configs.set('orion', { skills: { disabled: ['mail'] }, model: { default: 'old', provider: 'anthropic' } })
    gw.configs.set('nova', { skills: {} })
    gw.files.set('~/.hermes/profiles/orion/memories/MEMORY.md', 'Orion keeps its own note.\n')
    gw.files.set('~/.hermes/profiles/orion/memories/USER.md', 'Likes lists.\n')
    gw.files.set('~/.hermes/hindsight/config.json', '{"bank_id":"team","api_key":"secretsecretsecretsecret"}')
    const workspace = createWorkspace({ gateway: gw, now: () => new Date('2026-11-22T10:00:00.000Z'), random: () => 'abc123' })

    const added = await workspace.memoryChange({
      action: 'add', profiles: ['orion', 'nova'], type: 'people', text: 'Acme is a fictional client.', learnedBy: 'orion',
    })
    expect(added.fact.text).toBe('Acme is a fictional client.')
    expect(gw.files.get(TYPE_FILES.people)).toContain('Acme is a fictional client.')
    expect(gw.files.get('~/.hermes/shared-memory/skill/SKILL.md')).toContain('hermesbot-shared-memory')
    expect(gw.files.get('~/.hermes/profiles/orion/memories/MEMORY.md')).toContain(SHARED_MARKER)
    expect(gw.files.get('~/.hermes/profiles/orion/memories/MEMORY.md')).toContain('own note')
    expect(gw.configs.get('orion').skills.disabled).toEqual(['mail'])
    expect(gw.configs.get('orion').skills.external_dirs).toContain('~/.hermes/shared-memory/skill')
    expect(gw.configs.get('nova').skills.external_dirs).toContain('~/.hermes/shared-memory/skill')

    const view = await workspace.memoryView({ profiles: ['orion', 'default'] })
    expect(view.facts.map((fact) => fact.text)).toContain('Acme is a fictional client.')
    expect(view.learned).toEqual(expect.arrayContaining([
      expect.objectContaining({ profile: 'orion', store: 'user', text: 'Likes lists.' }),
    ]))
    expect(view.learned.some((entry) => entry.text.includes(SHARED_MARKER))).toBe(false)
    expect(view.providers).toEqual([
      expect.objectContaining({ profile: 'orion', provider: 'hindsight', active: true, bank: '' }),
      expect.objectContaining({ profile: 'default', provider: 'hindsight', active: true, bank: 'team' }),
    ])
    expect(JSON.stringify(view.providers)).not.toContain('secret')

    await workspace.memoryChange({ action: 'forget', profiles: ['orion'], id: added.fact.id })
    const after = await workspace.memoryView({ profiles: [] })
    expect(after.facts).toEqual([])
  })

  it('toggles a skill through config when the skills route is missing', async () => {
    const gw = gateway()
    gw.configs.set('orion', { skills: { disabled: [], external_dirs: ['~/keep'] } })
    const workspace = createWorkspace({
      gateway: gw,
      scanLocalSkills: async () => [{ path: '/home/skills/mail/SKILL.md', text: '---\nname: mail-approval\ndescription: Approve mail\n---\n' }],
    })
    const listed = await workspace.skills({ profile: 'orion' })
    expect(listed.source).toBe('files')
    expect(listed.skills[0]).toMatchObject({ name: 'mail-approval', enabled: true })
    const toggled = await workspace.toggleSkill({ profile: 'orion', name: 'mail-approval', enabled: false })
    expect(toggled.via).toBe('config')
    expect(gw.configs.get('orion').skills.disabled).toEqual(['mail-approval'])
    expect(gw.configs.get('orion').skills.external_dirs).toEqual(['~/keep'])
    const hub = await workspace.hubSearch({ profile: 'orion', query: 'mail' })
    expect(hub.supported).toBe(false)
    const install = await workspace.hubInstall({ profile: 'orion', identifier: 'official/mail' })
    expect(install.supported).toBe(false)
  })

  it('writes the persona and the default model when the profile routes are missing, and toggles a toolset when the route exists', async () => {
    const gw = gateway()
    gw.configs.set('orion', { model: { default: 'old', provider: 'anthropic', base_url: 'http://127.0.0.1:9' } })
    const workspace = createWorkspace({ gateway: gw })
    const sheet = await workspace.botSheet({ profile: 'orion' })
    expect(sheet.model).toBe('old')
    expect(sheet.toolsets).toEqual([expect.objectContaining({ name: 'web', enabled: true })])
    expect(sheet.toolsetsEditable).toBe(true)
    const saved = await workspace.saveBotSheet({
      profile: 'orion',
      persona: 'You write in short sentences.',
      model: 'claude-sonnet',
      provider: 'anthropic',
      toolsets: [{ name: 'web', enabled: false }],
    })
    expect(saved.saved.persona).toBe('file')
    expect(saved.saved.model).toBe('config')
    expect(gw.files.get('~/.hermes/profiles/orion/SOUL.md')).toBe('You write in short sentences.')
    expect(gw.configs.get('orion').model).toMatchObject({ default: 'claude-sonnet', provider: 'anthropic', base_url: 'http://127.0.0.1:9' })
    expect(saved.saved.toolsets).toEqual([{ name: 'web', enabled: false, ok: true }])
  })
})
