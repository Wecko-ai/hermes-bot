// Connectors and skills for the window. Hermes keeps the catalog, the skill files and the
// OAuth credential. This module only forwards an allowlisted set of gateway routes and returns
// a reduced view: no token, no client secret, no launch arguments, no file path.

import { readCappedText } from './http-limits.mjs'

export const PROFILE_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/
const CONNECTOR_NAME = /^[\w.-]{1,80}$/
const FLOW_ID = /^[A-Za-z0-9_-]{8,128}$/
const MAX_PROFILES = 40
const MAX_NAMES = 40
const UPSTREAM_MAX = 1_000_000
const SKILL_TEXT_MAX = 200_000

const LIBRARY_PATHS = new Set([
  '/api/connectors',
  '/api/connectors/install',
  '/api/connectors/auth',
  '/api/connectors/enabled',
  '/api/connectors/status',
  '/api/skills/library',
  '/api/skills/library/content',
  '/api/skills/library/enabled',
  '/api/skills/hub',
  '/api/skills/hub/install',
])

export function isLibraryPath(pathname) {
  if (LIBRARY_PATHS.has(pathname)) return true
  return /^\/api\/connectors\/oauth\/[^/]+$/.test(pathname)
}

export function clip(value, max) {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

/** Short text safe to show. Query credentials are masked; the rest is left readable. */
export function publicText(value, max) {
  return clip(value, max).replace(/([?&#](?:code|token|access_token|refresh_token|id_token|client_secret)=)[^&\s#]+/gi, '$1[redacted]')
}

/** Error text. Long opaque strings are masked so a token in an exception never reaches the window. */
export function redactText(value) {
  return publicText(value, 400)
    .replace(/bearer\s+\S+/gi, 'bearer [redacted]')
    .replace(/[A-Za-z0-9_\-+/=]{32,}/g, '[redacted]')
    .slice(0, 240)
}

export function safeConnectorName(value) {
  if (typeof value !== 'string') return ''
  const name = value.trim()
  if (!CONNECTOR_NAME.test(name) || name.includes('..')) return ''
  return name
}

export function safeSkillName(value) {
  if (typeof value !== 'string') return ''
  const name = value.trim()
  if (!name || name.length > 120 || name === '.' || name === '..') return ''
  if (name.includes('/') || name.includes('\\') || /[\u0000-\u001f\u007f]/.test(name)) return ''
  return name
}

export function safeIdentifier(value) {
  if (typeof value !== 'string') return ''
  const ident = value.trim()
  if (!ident || ident.length > 400 || ident.includes('..') || ident.includes('\\') || /[\u0000-\u001f\u007f]/.test(ident)) return ''
  return ident
}

export function safeFlowId(value) {
  return typeof value === 'string' && FLOW_ID.test(value) ? value : ''
}

export function profilesFrom(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  return [...new Set(list.filter((slug) => typeof slug === 'string' && PROFILE_SLUG.test(slug)))].slice(0, MAX_PROFILES)
}

/** Authorization page Hermes asks the browser to open. Anything else is dropped. */
export function authorizationUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return ''
  let url
  try { url = new URL(value) } catch { return '' }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname || url.username || url.password) return ''
  return url.href
}

function endpointLabel(raw) {
  if (typeof raw?.url === 'string') {
    try {
      const url = new URL(raw.url)
      if (!url.hostname || url.username || url.password) return ''
      return url.hostname.slice(0, 120)
    } catch { return '' }
  }
  if (typeof raw?.command === 'string') {
    const base = raw.command.split(/[/\\]/).pop() || ''
    return /^[\w.@+-]{1,80}$/.test(base) ? base : ''
  }
  return ''
}

function envPrompts(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 12).map((item) => {
    const name = typeof item?.name === 'string' && /^[A-Z][A-Z0-9_]{0,80}$/.test(item.name) ? item.name : ''
    if (!name) return null
    return { name, prompt: publicText(item.prompt, 160), required: item.required !== false }
  }).filter(Boolean)
}

const AUTH_TYPES = new Set(['oauth', 'none', 'header', 'env'])

export function publicEntry(raw) {
  if (!raw || typeof raw !== 'object') return null
  const name = safeConnectorName(raw.name)
  if (!name) return null
  const auth = AUTH_TYPES.has(raw.auth_type) ? raw.auth_type : 'none'
  const transport = typeof raw.transport === 'string' && /^[\w.-]{1,24}$/.test(raw.transport) ? raw.transport : 'unknown'
  return {
    name,
    description: publicText(raw.description, 400),
    authType: auth,
    transport,
    endpoint: endpointLabel(raw),
    requiredEnv: envPrompts(raw.required_env),
    postInstall: publicText(raw.post_install, 400),
    installed: raw.installed === true,
    enabled: raw.enabled === true,
  }
}

export function immediateStatus(entry) {
  if (!entry?.installed) return { status: 'available', error: '' }
  if (entry.authType === 'oauth') return { status: 'unknown', error: '' }
  return { status: entry.enabled ? 'connected' : 'off', error: '' }
}

export function statusFromProbe(entry, probe) {
  if (!entry?.installed) return { status: 'available', error: '' }
  if (!probe) return immediateStatus(entry)
  if (probe.ok) return { status: entry.enabled ? 'connected' : 'off', error: '' }
  const raw = typeof probe.error === 'string' ? probe.error : ''
  if (entry.authType === 'oauth' && /no token|authentication required/i.test(raw)) return { status: 'needs_auth', error: '' }
  return { status: 'error', error: redactText(raw) }
}

export function presentCatalog(profiles, pages) {
  const unsupported = profiles.filter((slug) => pages[slug]?.unsupported && !pages[slug]?.failed)
  const failed = profiles.filter((slug) => pages[slug]?.failed)
  const ready = profiles.filter((slug) => pages[slug] && !pages[slug].unsupported && !pages[slug].failed)
  const names = []
  const seen = new Set()
  for (const slug of ready) {
    for (const entry of pages[slug].entries) {
      if (seen.has(entry.name)) continue
      seen.add(entry.name)
      names.push(entry.name)
    }
  }
  const entries = names.slice(0, 200).map((name) => {
    const sample = ready.map((slug) => pages[slug].entries.find((entry) => entry.name === name)).find(Boolean)
    return {
      name: sample.name,
      description: sample.description,
      authType: sample.authType,
      transport: sample.transport,
      endpoint: sample.endpoint,
      requiredEnv: sample.requiredEnv,
      postInstall: sample.postInstall,
      bots: ready.map((slug) => {
        const entry = pages[slug].entries.find((item) => item.name === name)
        const installed = entry?.installed === true
        const enabled = entry?.enabled === true
        const state = entry ? { ...entry, installed, enabled } : { installed: false, enabled: false, authType: sample.authType }
        const status = immediateStatus(state)
        return { profile: slug, installed, enabled, status: status.status, error: status.error }
      }),
    }
  })
  return { entries, unsupported, failed }
}

const PROVENANCE = new Set(['hub', 'bundled', 'external', 'agent'])

export function publicSkill(raw) {
  if (!raw || typeof raw !== 'object') return null
  const name = safeSkillName(raw.name)
  if (!name) return null
  return {
    name,
    description: publicText(raw.description, 400),
    enabled: raw.enabled !== false,
    provenance: PROVENANCE.has(raw.provenance) ? raw.provenance : 'agent',
  }
}

/** Shared skills stay shared. A name that exists only on the bot is that bot's own skill. */
export function mergeSkills(sharedList, botList) {
  const sharedNames = new Set(sharedList.map((skill) => skill.name))
  const botByName = new Map(botList.map((skill) => [skill.name, skill]))
  const skills = []
  for (const skill of sharedList) {
    const overlay = botByName.get(skill.name)
    skills.push({ ...skill, scope: 'shared', enabled: overlay ? overlay.enabled : skill.enabled })
  }
  for (const skill of botList) {
    if (!sharedNames.has(skill.name)) skills.push({ ...skill, scope: 'bot' })
  }
  return skills
}

function installedSet(value) {
  if (Array.isArray(value)) return new Set(value.filter((item) => typeof item === 'string'))
  if (value && typeof value === 'object') return new Set(Object.keys(value).filter((key) => value[key]))
  return new Set()
}

export function publicHubSkill(raw, installed) {
  if (!raw || typeof raw !== 'object') return null
  const identifier = safeIdentifier(raw.identifier)
  const name = publicText(raw.name, 120)
  if (!identifier || !name) return null
  const trust = raw.trust_level === 'community' ? 'community' : 'reviewed'
  const flagged = raw.installed === true || (installed ? installed.has(identifier) : false)
  return {
    identifier,
    name,
    description: publicText(raw.description, 300),
    category: publicText(raw.category, 40),
    trust,
    installed: flagged,
  }
}

export function publicHubList(body) {
  const installed = installedSet(body?.installed)
  const rows = Array.isArray(body?.skills) ? body.skills : Array.isArray(body?.results) ? body.results : []
  return rows.slice(0, 300).map((row) => publicHubSkill(row, installed)).filter(Boolean)
}

export function envPayload(value, declared) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const allow = new Set(declared)
  const out = {}
  let count = 0
  for (const [key, raw] of Object.entries(value)) {
    if (count >= 12 || !allow.has(key) || typeof raw !== 'string') continue
    const secret = raw.trim()
    if (!secret || secret.length > 4096) continue
    out[key] = secret
    count += 1
  }
  return out
}

export function connectSteps(installed, authType, status) {
  const steps = []
  if (!installed) steps.push('install')
  if (authType === 'oauth' && status !== 'connected' && status !== 'off') steps.push('oauth')
  return steps
}

async function readUpstream(upstream) {
  let text = ''
  try {
    text = await readCappedText(upstream, UPSTREAM_MAX)
  } catch {
    await upstream.body?.cancel?.().catch(() => {})
    return { status: 502, body: {} }
  }
  if (!text) return { status: upstream.status, body: {} }
  try {
    return { status: upstream.status, body: JSON.parse(text) }
  } catch {
    return { status: upstream.status, body: {} }
  }
}

function upstreamMessage(body) {
  if (!body || typeof body !== 'object') return ''
  const detail = body.detail ?? body.error ?? body.message
  return redactText(typeof detail === 'string' ? detail : '')
}

function reject(json, response, upstream) {
  const message = upstreamMessage(upstream.body)
  if (upstream.status === 404) return json(response, 404, { error: 'not_found', message })
  if (upstream.status === 409) return json(response, 409, { error: 'conflict', message })
  if (upstream.status === 429) return json(response, 429, { error: 'busy', message })
  if (upstream.status === 401 || upstream.status === 403) return json(response, 401, { error: 'unauthenticated', message: '' })
  if (upstream.status >= 500 || upstream.status === 502) return json(response, 502, { error: 'hermes_unavailable', message })
  return json(response, 400, { error: 'rejected', message })
}

async function callHermes(hermesFetch, request, route, options = {}) {
  const upstream = await hermesFetch(request, route, options)
  return readUpstream(upstream)
}

function profileQuery(profile) {
  return profile ? `?${new URLSearchParams({ profile })}` : ''
}

async function readCatalogPage(hermesFetch, request, profile) {
  const upstream = await callHermes(hermesFetch, request, `/api/mcp/catalog${profileQuery(profile)}`)
  if (upstream.status === 404) return { unsupported: true, entries: [], diagnostics: [] }
  if (upstream.status >= 400) return { error: upstream, entries: [], diagnostics: [] }
  const entries = Array.isArray(upstream.body?.entries) ? upstream.body.entries.map(publicEntry).filter(Boolean) : []
  return { entries, diagnostics: Array.isArray(upstream.body?.diagnostics) ? upstream.body.diagnostics : [] }
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      out[index] = await fn(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

function skillRows(body) {
  const rows = Array.isArray(body) ? body : Array.isArray(body?.skills) ? body.skills : []
  return rows.map(publicSkill).filter(Boolean)
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {URL} url
 * @param {{ json: Function, hermesFetch: Function, session: unknown, originAllowed: boolean, readBody: () => Promise<any> }} deps
 */
export async function handleLibrary(request, response, url, deps) {
  const { json, hermesFetch, session, originAllowed, readBody } = deps
  if (!session) return json(response, 401, { error: 'unauthenticated' })
  const pathname = url.pathname
  const method = request.method || 'GET'
  const writing = method !== 'GET' && method !== 'HEAD'
  if (writing && !originAllowed) return json(response, 403, { error: 'forbidden_origin' })

  const flowMatch = /^\/api\/connectors\/oauth\/([^/]+)$/.exec(pathname)
  if (flowMatch) return oauthFlow(request, response, flowMatch[1], method, deps)

  if (pathname === '/api/connectors' && method === 'GET') return listConnectors(request, response, url, deps)
  if (pathname === '/api/connectors' && method === 'DELETE') return removeConnector(request, response, url, deps)
  if (pathname === '/api/connectors/install' && method === 'POST') return installConnector(request, response, deps)
  if (pathname === '/api/connectors/auth' && method === 'POST') return startAuth(request, response, deps)
  if (pathname === '/api/connectors/enabled' && method === 'PUT') return setEnabled(request, response, deps)
  if (pathname === '/api/connectors/status' && method === 'POST') return connectorStatus(request, response, deps)
  if (pathname === '/api/skills/library' && method === 'GET') return listSkills(request, response, url, deps)
  if (pathname === '/api/skills/library/content' && method === 'GET') return skillContent(request, response, url, deps)
  if (pathname === '/api/skills/library/enabled' && method === 'PUT') return setSkillEnabled(request, response, deps)
  if (pathname === '/api/skills/hub' && method === 'GET') return hubList(request, response, url, deps)
  if (pathname === '/api/skills/hub/install' && method === 'POST') return hubInstall(request, response, deps)

  return json(response, 404, { error: 'not_found' })
}

async function listConnectors(request, response, url, { json, hermesFetch }) {
  const profiles = profilesFrom(url.searchParams.get('profiles') || '')
  if (!profiles.length) return json(response, 400, { error: 'invalid_profile' })
  const pages = {}
  let failure = null
  await mapPool(profiles, 4, async (profile) => {
    const page = await readCatalogPage(hermesFetch, request, profile)
    if (page.error && !failure) failure = page.error
    pages[profile] = page.error ? { failed: true, entries: [] } : page
  })
  const ready = profiles.filter((profile) => pages[profile] && !pages[profile].unsupported && !pages[profile].failed)
  if (!ready.length && profiles.some((profile) => pages[profile]?.failed)) return reject(json, response, failure || { status: 502, body: {} })
  const view = presentCatalog(profiles, pages)
  const diagnostics = []
  for (const profile of profiles) {
    for (const item of (pages[profile]?.diagnostics || []).slice(0, 8)) {
      const message = redactText(item?.message)
      if (!message) continue
      diagnostics.push({ name: publicText(item?.name, 80), kind: publicText(item?.kind, 40), message })
    }
  }
  return json(response, 200, { ...view, diagnostics: diagnostics.slice(0, 20) })
}

async function installConnector(request, response, { json, hermesFetch, readBody }) {
  const body = await readBody()
  const name = safeConnectorName(body.name)
  const profile = typeof body.profile === 'string' && PROFILE_SLUG.test(body.profile) ? body.profile : ''
  if (!name || !profile) return json(response, 400, { error: 'invalid_connector' })
  const page = await readCatalogPage(hermesFetch, request, profile)
  if (page.unsupported) return json(response, 404, { error: 'not_found' })
  if (page.error) return reject(json, response, page.error)
  const entry = page.entries.find((item) => item.name === name)
  if (!entry) return json(response, 404, { error: 'not_found' })
  const env = envPayload(body.env, entry.requiredEnv.map((item) => item.name))
  const payload = { name, enable: body.enable !== false, profile }
  if (Object.keys(env).length) payload.env = env
  const upstream = await callHermes(hermesFetch, request, '/api/mcp/catalog/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    timeout: 60_000,
  })
  if (upstream.status >= 400) return reject(json, response, upstream)
  return json(response, 200, { ok: true, name, background: upstream.body?.background === true })
}

async function startAuth(request, response, { json, hermesFetch, readBody }) {
  const body = await readBody()
  const name = safeConnectorName(body.name)
  const profile = typeof body.profile === 'string' && PROFILE_SLUG.test(body.profile) ? body.profile : ''
  if (!name || !profile) return json(response, 400, { error: 'invalid_connector' })
  const upstream = await callHermes(hermesFetch, request, `/api/mcp/servers/${encodeURIComponent(name)}/auth${profileQuery(profile)}`, {
    method: 'POST',
    timeout: 40_000,
  })
  if (upstream.status >= 400) return reject(json, response, upstream)
  return json(response, 200, {
    flowId: safeFlowId(upstream.body?.flow_id),
    status: publicText(upstream.body?.status, 40) || 'starting',
    authorizationUrl: authorizationUrl(upstream.body?.authorization_url),
    error: redactText(upstream.body?.error),
  })
}

async function oauthFlow(request, response, rawId, method, { json, hermesFetch }) {
  const flowId = safeFlowId(decodeURIComponent(rawId))
  if (!flowId) return json(response, 400, { error: 'invalid_flow' })
  if (method !== 'GET' && method !== 'DELETE') return json(response, 404, { error: 'not_found' })
  const upstream = await callHermes(hermesFetch, request, `/api/mcp/oauth/flows/${encodeURIComponent(flowId)}`, { method })
  if (upstream.status >= 400) return reject(json, response, upstream)
  if (method === 'DELETE') return json(response, 200, { ok: true })
  return json(response, 200, {
    status: publicText(upstream.body?.status, 40) || 'unknown',
    error: redactText(upstream.body?.error),
  })
}

async function setEnabled(request, response, { json, hermesFetch, readBody }) {
  const body = await readBody()
  const name = safeConnectorName(body.name)
  const profile = typeof body.profile === 'string' && PROFILE_SLUG.test(body.profile) ? body.profile : ''
  if (!name || !profile || typeof body.enabled !== 'boolean') return json(response, 400, { error: 'invalid_connector' })
  const upstream = await callHermes(hermesFetch, request, `/api/mcp/servers/${encodeURIComponent(name)}/enabled`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: body.enabled, profile }),
  })
  if (upstream.status >= 400) return reject(json, response, upstream)
  return json(response, 200, { ok: true, name, profile, enabled: body.enabled })
}

async function removeConnector(request, response, url, { json, hermesFetch }) {
  const name = safeConnectorName(url.searchParams.get('name') || '')
  const profile = url.searchParams.get('profile') || ''
  if (!name || !PROFILE_SLUG.test(profile)) return json(response, 400, { error: 'invalid_connector' })
  const upstream = await callHermes(hermesFetch, request, `/api/mcp/servers/${encodeURIComponent(name)}${profileQuery(profile)}`, { method: 'DELETE' })
  if (upstream.status >= 400) return reject(json, response, upstream)
  return json(response, 200, { ok: true, name, profile })
}

async function connectorStatus(request, response, { json, hermesFetch, readBody }) {
  const body = await readBody()
  const profiles = profilesFrom(body.profiles)
  const names = [...new Set((Array.isArray(body.names) ? body.names : []).map(safeConnectorName).filter(Boolean))].slice(0, MAX_NAMES)
  if (!profiles.length || !names.length) return json(response, 400, { error: 'invalid_connector' })
  const wanted = new Set(names)
  const results = {}
  await mapPool(profiles, 3, async (profile) => {
    const page = await readCatalogPage(hermesFetch, request, profile)
    results[profile] = {}
    if (page.unsupported || page.error) {
      for (const name of names) results[profile][name] = { status: 'error', error: '' }
      return
    }
    const probes = []
    for (const name of names) {
      const entry = page.entries.find((item) => item.name === name)
      if (!entry || !wanted.has(name)) {
        results[profile][name] = { status: 'available', error: '' }
        continue
      }
      if (entry.installed && probes.length < 12) probes.push(entry)
      else results[profile][name] = immediateStatus(entry)
    }
    await mapPool(probes, 3, async (entry) => {
      const upstream = await callHermes(hermesFetch, request, `/api/mcp/servers/${encodeURIComponent(entry.name)}/test${profileQuery(profile)}`, {
        method: 'POST',
        timeout: 20_000,
      })
      const probe = upstream.status >= 400
        ? { ok: false, error: upstreamMessage(upstream.body) }
        : { ok: upstream.body?.ok === true, error: typeof upstream.body?.error === 'string' ? upstream.body.error : '' }
      results[profile][entry.name] = statusFromProbe(entry, probe)
    })
  })
  return json(response, 200, { results })
}

async function listSkills(request, response, url, { json, hermesFetch }) {
  const profile = url.searchParams.get('profile') || ''
  if (profile && !PROFILE_SLUG.test(profile)) return json(response, 400, { error: 'invalid_profile' })
  const shared = await callHermes(hermesFetch, request, '/api/skills')
  if (shared.status === 404) return json(response, 200, { unsupported: true, skills: [] })
  if (shared.status >= 400) return reject(json, response, shared)
  const sharedSkills = skillRows(shared.body)
  if (!profile) return json(response, 200, { unsupported: false, skills: sharedSkills.map((skill) => ({ ...skill, scope: 'shared' })) })
  const own = await callHermes(hermesFetch, request, `/api/skills${profileQuery(profile)}`)
  if (own.status === 404) return json(response, 200, { unsupported: false, skills: sharedSkills.map((skill) => ({ ...skill, scope: 'shared' })) })
  if (own.status >= 400) return reject(json, response, own)
  return json(response, 200, { unsupported: false, skills: mergeSkills(sharedSkills, skillRows(own.body)) })
}

async function skillContent(request, response, url, { json, hermesFetch }) {
  const name = safeSkillName(url.searchParams.get('name') || '')
  const profile = url.searchParams.get('profile') || ''
  if (!name || (profile && !PROFILE_SLUG.test(profile))) return json(response, 400, { error: 'invalid_skill' })
  const upstream = await callHermes(hermesFetch, request, `/api/skills/content?${new URLSearchParams({ name, ...(profile ? { profile } : {}) })}`)
  if (upstream.status >= 400) return reject(json, response, upstream)
  const content = typeof upstream.body?.content === 'string' ? upstream.body.content.replace(/^\uFEFF/, '') : ''
  if (content.length > SKILL_TEXT_MAX) return json(response, 413, { error: 'too_large' })
  return json(response, 200, { name, content })
}

async function setSkillEnabled(request, response, { json, hermesFetch, readBody }) {
  const body = await readBody()
  const name = safeSkillName(body.name)
  const profile = typeof body.profile === 'string' && PROFILE_SLUG.test(body.profile) ? body.profile : ''
  if (!name || !profile || typeof body.enabled !== 'boolean') return json(response, 400, { error: 'invalid_skill' })
  const upstream = await callHermes(hermesFetch, request, '/api/skills/toggle', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, enabled: body.enabled, profile }),
  })
  if (upstream.status >= 400) return reject(json, response, upstream)
  return json(response, 200, { ok: true, name, profile, enabled: body.enabled })
}

async function hubList(request, response, url, { json, hermesFetch }) {
  const profile = url.searchParams.get('profile') || ''
  if (profile && !PROFILE_SLUG.test(profile)) return json(response, 400, { error: 'invalid_profile' })
  const query = publicText(url.searchParams.get('q') || '', 120)
  const route = query
    ? `/api/skills/hub/search?${new URLSearchParams({ q: query, limit: '20', ...(profile ? { profile } : {}) })}`
    : `/api/skills/hub/official${profileQuery(profile)}`
  const upstream = await callHermes(hermesFetch, request, route, { timeout: query ? 40_000 : 20_000 })
  if (upstream.status === 404) return json(response, 200, { unsupported: true, skills: [] })
  if (upstream.status >= 400) return reject(json, response, upstream)
  return json(response, 200, { unsupported: false, skills: publicHubList(upstream.body) })
}

async function hubInstall(request, response, { json, hermesFetch, readBody }) {
  const body = await readBody()
  const identifier = safeIdentifier(body.identifier)
  const profile = typeof body.profile === 'string' && body.profile ? body.profile : ''
  if (!identifier || (profile && !PROFILE_SLUG.test(profile))) return json(response, 400, { error: 'invalid_skill' })
  const payload = profile ? { identifier, profile } : { identifier }
  const upstream = await callHermes(hermesFetch, request, '/api/skills/hub/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    timeout: 30_000,
  })
  if (upstream.status >= 400) return reject(json, response, upstream)
  return json(response, 200, { ok: true, background: true })
}
