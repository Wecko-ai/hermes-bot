import { describe, expect, it } from 'vitest'
import {
  authorizationUrl, connectSteps, envPayload, handleLibrary, immediateStatus, isLibraryPath,
  mergeSkills, presentCatalog, publicEntry, publicHubList, publicSkill, redactText, statusFromProbe,
} from './library.mjs'

const SECRET = 'sekret-token-value-should-not-leak-0123456789abcdef'

function response() {
  return {
    status: 0,
    body: '',
    writeHead(code) { this.status = code },
    end(data) { this.body = data },
    json() { return JSON.parse(this.body) },
  }
}

function json(res, status, body) {
  res.writeHead(status)
  res.end(JSON.stringify(body))
}

function upstream(status, body) {
  return { status, text: async () => JSON.stringify(body), body: null }
}

function catalogEntry(extra = {}) {
  return {
    name: 'harbor',
    description: 'A mailbox.',
    auth_type: 'oauth',
    transport: 'http',
    url: 'https://mcp.example.test/mcp',
    command: 'ignored',
    args: ['--token', SECRET],
    required_env: [{ name: 'HARBOR_TOKEN', prompt: 'Token', required: true, value: SECRET }],
    post_install: 'Approve access in the browser.',
    installed: false,
    enabled: false,
    access_token: SECRET,
    ...extra,
  }
}

describe('library view', () => {
  it('keeps the catalog description and drops credentials, arguments and token fields', () => {
    const entry = publicEntry(catalogEntry())
    expect(entry).toMatchObject({
      name: 'harbor', description: 'A mailbox.', authType: 'oauth', endpoint: 'mcp.example.test', installed: false,
    })
    expect(entry.requiredEnv).toEqual([{ name: 'HARBOR_TOKEN', prompt: 'Token', required: true }])
    expect(JSON.stringify(entry)).not.toContain(SECRET)
    expect(entry.args).toBeUndefined()
    expect(entry.url).toBeUndefined()
  })

  it('classifies a connector without reading a credential', () => {
    expect(immediateStatus({ installed: false, authType: 'oauth' }).status).toBe('available')
    expect(immediateStatus({ installed: true, enabled: true, authType: 'none' }).status).toBe('connected')
    expect(statusFromProbe({ installed: true, enabled: true, authType: 'none' }, { ok: false, error: 'connection refused' }).status).toBe('error')
    expect(immediateStatus({ installed: true, enabled: false, authType: 'none' }).status).toBe('off')
    expect(immediateStatus({ installed: true, enabled: true, authType: 'oauth' }).status).toBe('unknown')
    expect(statusFromProbe({ installed: true, enabled: true, authType: 'oauth' }, { ok: true }).status).toBe('connected')
    expect(statusFromProbe({ installed: true, enabled: false, authType: 'oauth' }, { ok: true }).status).toBe('off')
    expect(statusFromProbe(
      { installed: true, enabled: true, authType: 'oauth' },
      { ok: false, error: `OAuth authentication required — no token found. ${SECRET}` },
    )).toEqual({ status: 'needs_auth', error: '' })
    const failed = statusFromProbe(
      { installed: true, enabled: true, authType: 'oauth' },
      { ok: false, error: `connection refused ${SECRET}` },
    )
    expect(failed.status).toBe('error')
    expect(failed.error).not.toContain(SECRET)
    expect(failed.error).toContain('[redacted]')
  })

  it('merges one catalog across bots and keeps a shared skill distinct from a bot skill', () => {
    const harbor = publicEntry(catalogEntry({ installed: true, enabled: true }))
    const view = presentCatalog(['nova', 'orion'], {
      nova: { entries: [harbor] },
      orion: { entries: [publicEntry(catalogEntry())] },
    })
    expect(view.entries[0].bots).toEqual([
      { profile: 'nova', installed: true, enabled: true, status: 'unknown', error: '' },
      { profile: 'orion', installed: false, enabled: false, status: 'available', error: '' },
    ])
    const shared = [publicSkill({ name: 'mail-approval', description: 'Ask first', enabled: false, provenance: 'bundled' })]
    const own = [
      publicSkill({ name: 'mail-approval', description: 'Ask first', enabled: true, provenance: 'bundled' }),
      publicSkill({ name: 'weekly-notes', description: 'Notes', enabled: true, provenance: 'agent' }),
    ]
    expect(mergeSkills(shared, own)).toEqual([
      { name: 'mail-approval', description: 'Ask first', enabled: true, provenance: 'bundled', scope: 'shared' },
      { name: 'weekly-notes', description: 'Notes', enabled: true, provenance: 'agent', scope: 'bot' },
    ])
  })

  it('lists hub skills without their files and only forwards declared env names', () => {
    const skills = publicHubList({
      skills: [{ name: 'Places', identifier: 'official/maps/places', description: 'Nearby', trust_level: 'builtin', skill_md: SECRET, path: `/tmp/${SECRET}` }],
      installed: ['official/maps/places'],
    })
    expect(skills).toEqual([{
      identifier: 'official/maps/places', name: 'Places', description: 'Nearby', category: '', trust: 'reviewed', installed: true,
    }])
    expect(JSON.stringify(skills)).not.toContain(SECRET)
    expect(envPayload({ HARBOR_TOKEN: 'one', OTHER: SECRET, HARBOR_TOKEN2: 4 }, ['HARBOR_TOKEN'])).toEqual({ HARBOR_TOKEN: 'one' })
    expect(connectSteps(false, 'oauth', 'available')).toEqual(['install', 'oauth'])
    expect(connectSteps(true, 'oauth', 'needs_auth')).toEqual(['oauth'])
    expect(connectSteps(true, 'oauth', 'connected')).toEqual([])
  })

  it('accepts an authorization page and refuses other urls', () => {
    expect(authorizationUrl('https://auth.example.test/authorize?state=abc')).toBe('https://auth.example.test/authorize?state=abc')
    expect(authorizationUrl('javascript:alert(1)')).toBe('')
    expect(authorizationUrl('https://user:pass@auth.example.test/authorize')).toBe('')
    expect(redactText(`failed code=${SECRET}&access_token=${SECRET}`)).not.toContain(SECRET)
    expect(isLibraryPath('/api/connectors')).toBe(true)
    expect(isLibraryPath('/api/connectors/oauth/abcdefgh')).toBe(true)
    expect(isLibraryPath('/api/hermes/sessions')).toBe(false)
  })
})

describe('library routes', () => {
  function harness(routes) {
    const calls = []
    const hermesFetch = async (_request, route, options = {}) => {
      calls.push({ route, method: options.method || 'GET', body: options.body })
      const hit = routes(route, options)
      return upstream(hit.status, hit.body)
    }
    const deps = {
      json,
      hermesFetch,
      session: { id: 'session' },
      originAllowed: true,
      readBody: async () => JSON.parse(deps._body || '{}'),
    }
    return { calls, deps }
  }

  async function run(method, path, { body, routes, session = { id: 'session' }, originAllowed = true } = {}) {
    const { calls, deps } = harness(routes)
    deps.session = session
    deps.originAllowed = originAllowed
    deps._body = body || '{}'
    const url = new URL(path, 'http://127.0.0.1:4330')
    const res = response()
    await handleLibrary({ method, url: path }, res, url, deps)
    return { status: res.status, body: res.json(), calls }
  }

  const catalog = (profile) => ({
    status: 200,
    body: {
      entries: [catalogEntry({ installed: profile === 'nova', enabled: profile === 'nova' })],
      diagnostics: [{ name: 'harbor', kind: 'manifest', message: `bad ${SECRET}` }],
    },
  })

  it('requires a session and a local origin for a write', async () => {
    const denied = await run('GET', '/api/connectors?profiles=nova', { session: null, routes: () => ({ status: 200, body: {} }) })
    expect(denied.status).toBe(401)
    const foreign = await run('POST', '/api/connectors/install', { originAllowed: false, body: '{}', routes: () => ({ status: 200, body: {} }) })
    expect(foreign.status).toBe(403)
    expect(foreign.calls).toEqual([])
  })

  it('returns per-bot status and never the catalog secret', async () => {
    const listed = await run('GET', '/api/connectors?profiles=nova,orion,../etc', {
      routes: (route) => catalog(new URL(route, 'http://hermes').searchParams.get('profile')),
    })
    expect(listed.status).toBe(200)
    expect(listed.body.entries[0].bots.map((bot) => bot.profile)).toEqual(['nova', 'orion'])
    expect(listed.body.entries[0].bots[0]).toMatchObject({ installed: true, status: 'unknown' })
    expect(JSON.stringify(listed.body)).not.toContain(SECRET)
    expect(listed.body.diagnostics[0].message).toContain('[redacted]')
  })

  it('forwards only the declared credential and does not echo it', async () => {
    const installed = await run('POST', '/api/connectors/install', {
      body: JSON.stringify({ name: 'harbor', profile: 'nova', env: { HARBOR_TOKEN: 'one-time', OTHER: SECRET } }),
      routes: (route) => route.startsWith('/api/mcp/catalog?') ? catalog('nova') : { status: 200, body: { ok: true, background: false, env: SECRET } },
    })
    expect(installed.status).toBe(200)
    expect(installed.body).toEqual({ ok: true, name: 'harbor', background: false })
    const sent = JSON.parse(installed.calls.find((call) => call.method === 'POST').body)
    expect(sent.env).toEqual({ HARBOR_TOKEN: 'one-time' })
    expect(JSON.stringify(installed.body)).not.toContain('one-time')
    expect(JSON.stringify(installed.body)).not.toContain(SECRET)
  })

  it('returns an authorization url once and a later poll with no credential', async () => {
    const started = await run('POST', '/api/connectors/auth', {
      body: JSON.stringify({ name: 'harbor', profile: 'nova' }),
      routes: () => ({
        status: 200,
        body: {
          flow_id: 'flow-12345678', status: 'authorization_required',
          authorization_url: 'https://auth.example.test/authorize?state=abc',
          access_token: SECRET, tools: [{ name: 'x' }],
        },
      }),
    })
    expect(started.body).toEqual({
      flowId: 'flow-12345678', status: 'authorization_required',
      authorizationUrl: 'https://auth.example.test/authorize?state=abc', error: '',
    })
    const polled = await run('GET', '/api/connectors/oauth/flow-12345678', {
      routes: () => ({ status: 200, body: { status: 'approved', authorization_url: 'https://auth.example.test/a', access_token: SECRET, tools: [{ name: 'x' }] } }),
    })
    expect(polled.body).toEqual({ status: 'approved', error: '' })
    expect(JSON.stringify(polled.body)).not.toContain(SECRET)
  })

  it('maps a live probe to needs sign-in without returning the probe payload', async () => {
    const probed = await run('POST', '/api/connectors/status', {
      body: JSON.stringify({ profiles: ['nova'], names: ['harbor'] }),
      routes: (route, options) => {
        if (route.startsWith('/api/mcp/catalog')) return catalog('nova')
        expect(options.method).toBe('POST')
        return { status: 200, body: { ok: false, error: 'OAuth authentication required — no token found.', tools: [{ name: SECRET }] } }
      },
    })
    expect(probed.body).toEqual({ results: { nova: { harbor: { status: 'needs_auth', error: '' } } } })
    expect(JSON.stringify(probed.body)).not.toContain(SECRET)
  })

  it('reads a skill document without its path and installs from the hub by identifier', async () => {
    const content = await run('GET', '/api/skills/library/content?name=mail-approval&profile=nova', {
      routes: () => ({ status: 200, body: { name: 'mail-approval', content: '# Mail\nAsk first.', path: `/Users/me/${SECRET}/SKILL.md` } }),
    })
    expect(content.body).toEqual({ name: 'mail-approval', content: '# Mail\nAsk first.' })
    const hub = await run('GET', '/api/skills/hub?profile=nova', {
      routes: () => ({ status: 200, body: { skills: [{ name: 'Places', identifier: 'official/maps/places', description: 'Nearby', trust_level: 'builtin', installed: false }], installed: [] } }),
    })
    expect(hub.body.skills[0]).toMatchObject({ identifier: 'official/maps/places', installed: false, trust: 'reviewed' })
    const install = await run('POST', '/api/skills/hub/install', {
      body: JSON.stringify({ identifier: 'official/maps/places', profile: 'nova' }),
      routes: () => ({ status: 200, body: { ok: true, action: 'skills-install', log: SECRET } }),
    })
    expect(install.body).toEqual({ ok: true, background: true })
    expect(JSON.stringify(install.body)).not.toContain(SECRET)
  })
})
