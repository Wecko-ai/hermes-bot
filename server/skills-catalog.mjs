// Skills as Hermes already stores them: SKILL.md files, enabled or disabled per profile
// (`skills.disabled` in that profile's config.yaml). The gateway's `/api/skills` is preferred.
// This module normalizes that payload and can read the same files when the route is absent.

const NAME = /^[a-z0-9][a-z0-9_-]{0,80}$/
const SKILL_FILE = /(?:^|\/)SKILL\.md$/i

export function cleanSkillName(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return NAME.test(text) ? text : ''
}

function frontmatter(text) {
  const source = typeof text === 'string' ? text : ''
  if (!source.startsWith('---\n')) return { meta: {}, body: source }
  const end = source.indexOf('\n---', 4)
  if (end < 0) return { meta: {}, body: source }
  const meta = {}
  for (const line of source.slice(4, end).split('\n')) {
    const split = line.indexOf(':')
    if (split < 1) continue
    const key = line.slice(0, split).trim()
    const value = line.slice(split + 1).trim().replace(/^["']|["']$/g, '')
    if (key && value) meta[key] = value
  }
  return { meta, body: source.slice(end + 4).trim() }
}

export function descriptionOf(text, fallback = '') {
  const { meta, body } = frontmatter(text)
  if (meta.description) return meta.description.slice(0, 280)
  const line = body.split('\n').map((item) => item.trim()).find((item) => item && !item.startsWith('#'))
  return (line || fallback).slice(0, 280)
}

export function nameOfSkill(text, fallback) {
  const { meta } = frontmatter(text)
  return cleanSkillName(meta.name) || cleanSkillName(fallback) || ''
}

/** `profile` when the file sits in that profile's skills directory, otherwise `shared`. */
export function skillScope(filePath, profile) {
  const path = typeof filePath === 'string' ? filePath.replace(/\\/g, '/') : ''
  if (profile && path.includes(`/profiles/${profile}/`)) return 'profile'
  if (path.includes('/shared-memory/skill/')) return 'shared'
  return 'shared'
}

export function normalizeSkill(raw, { profile = '', disabled = new Set() } = {}) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const filePath = typeof source.path === 'string' ? source.path : typeof source.skill_md === 'string' ? source.skill_md : ''
  const name = cleanSkillName(source.name) || nameOfSkill('', source.id)
  if (!name) return null
  const enabled = typeof source.enabled === 'boolean' ? source.enabled : !disabled.has(name)
  return {
    name,
    description: typeof source.description === 'string' ? source.description.slice(0, 280) : '',
    category: typeof source.category === 'string' ? source.category.slice(0, 80) : '',
    enabled,
    scope: skillScope(filePath, profile),
    path: allowedSkillPath(filePath) ? filePath : '',
    provenance: typeof source.provenance === 'string' ? source.provenance.slice(0, 24) : '',
  }
}

/** A SKILL.md path the gateway may read. Rejects traversal and anything that is not a skill file. */
export function allowedSkillPath(value) {
  if (typeof value !== 'string') return false
  const path = value.trim()
  if (!path || path.length > 500 || path.includes('..') || /[\u0000-\u001f]/.test(path)) return false
  if (!SKILL_FILE.test(path.replace(/\\/g, '/'))) return false
  return path.startsWith('~/') || path.startsWith('/')
}

/**
 * The config patch that enables or disables one skill, keeping every other `skills` key.
 * Returns null when the list would not change.
 */
export function disabledSkillsPatch(config, name, enabled) {
  const skill = cleanSkillName(name)
  if (!skill) return { error: 'invalid' }
  const skills = config && typeof config.skills === 'object' && config.skills && !Array.isArray(config.skills) ? { ...config.skills } : {}
  const disabled = new Set((Array.isArray(skills.disabled) ? skills.disabled : []).filter((item) => typeof item === 'string' && cleanSkillName(item)))
  const had = disabled.has(skill)
  if (enabled && !had) return null
  if (!enabled && had) return null
  if (enabled) disabled.delete(skill)
  else disabled.add(skill)
  return { config: { skills: { ...skills, disabled: [...disabled].sort() } } }
}

export function disabledNames(config) {
  const skills = config && typeof config.skills === 'object' ? config.skills : null
  const list = skills && Array.isArray(skills.disabled) ? skills.disabled : []
  return new Set(list.map(cleanSkillName).filter(Boolean))
}

/** One installed skill from a SKILL.md the scanner already read. */
export function skillFromFile({ path, text, profile, disabled }) {
  const fallback = path.replace(/\\/g, '/').split('/').slice(-2, -1)[0] || ''
  const name = nameOfSkill(text, fallback)
  if (!name) return null
  return normalizeSkill({
    name,
    description: descriptionOf(text),
    path,
    enabled: !disabled.has(name),
    provenance: path.includes('/shared-memory/skill/') ? 'shared' : 'local',
  }, { profile, disabled })
}

export function normalizeHubResult(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const name = typeof source.name === 'string' ? source.name.slice(0, 80) : ''
  const identifier = typeof source.identifier === 'string' ? source.identifier.slice(0, 200)
    : typeof source.id === 'string' ? source.id.slice(0, 200)
      : name
  if (!identifier) return null
  return {
    name: name || identifier,
    identifier,
    description: typeof source.description === 'string' ? source.description.slice(0, 280) : '',
    source: typeof source.source === 'string' ? source.source.slice(0, 40) : '',
    installed: source.installed === true,
  }
}

export function hubResultsOf(body) {
  const list = Array.isArray(body) ? body : Array.isArray(body?.results) ? body.results : Array.isArray(body?.skills) ? body.skills : []
  return list.map(normalizeHubResult).filter(Boolean).slice(0, 30)
}

/** A detail safe to show: no long tokens. */
export function publicDetail(value) {
  return String(value || '').replace(/[A-Za-z0-9_\-]{24,}/g, '…').replace(/\s+/g, ' ').trim().slice(0, 240)
}

export function normalizeToolset(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const name = typeof source.name === 'string' ? source.name.trim() : typeof source.key === 'string' ? source.key.trim() : ''
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) return null
  const tools = Array.isArray(source.tools) ? source.tools.filter((item) => typeof item === 'string').slice(0, 40).map((item) => item.slice(0, 60)) : []
  return {
    name,
    label: typeof source.label === 'string' && source.label.trim() ? source.label.trim().slice(0, 80) : name,
    description: typeof source.description === 'string' ? source.description.slice(0, 280) : '',
    enabled: source.enabled !== false,
    tools,
  }
}

export function toolsetsOf(body) {
  const list = Array.isArray(body) ? body : Array.isArray(body?.toolsets) ? body.toolsets : []
  return list.map(normalizeToolset).filter(Boolean).slice(0, 80)
}

/** Names already enabled in config, when the toolset route does not exist. Read only. */
export function toolsetsFromConfig(config) {
  const cli = config?.platform_toolsets?.cli
  if (!Array.isArray(cli)) return []
  return cli.map((name) => normalizeToolset({ name, enabled: true })).filter(Boolean).slice(0, 80)
}

export function modelOfConfig(config) {
  const model = config && typeof config.model === 'object' && config.model ? config.model : {}
  return {
    model: typeof model.default === 'string' ? model.default.slice(0, 120) : '',
    provider: typeof model.provider === 'string' ? model.provider.slice(0, 60) : '',
  }
}

/**
 * SKILL.md files under a Hermes home: the shared library, one profile's own skills, and the
 * shared-memory skill. `io` is `readdir` / `readFile` so tests can point at a temporary tree.
 */
export async function scanSkillFiles(root, profile, io) {
  if (typeof root !== 'string' || !root || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile)) return []
  const { readdir, readFile, join } = io
  const dirs = [
    join(root, 'skills'),
    join(root, 'profiles', profile, 'skills'),
    join(root, 'shared-memory', 'skill'),
  ]
  const found = []
  async function walk(dir, depth) {
    if (depth > 4 || found.length >= 400) return
    let names = []
    try { names = await readdir(dir) } catch { return }
    for (const entry of names) {
      const name = typeof entry === 'string' ? entry : entry?.name
      if (!name || name.startsWith('.')) continue
      const full = join(dir, name)
      const directory = typeof entry === 'object' && entry ? entry.isDirectory?.() === true : false
      if (directory) await walk(full, depth + 1)
      else if (name === 'SKILL.md') {
        const text = await readFile(full).catch(() => '')
        if (typeof text === 'string' && text.trim()) found.push({ path: full, text: text.slice(0, 48_000) })
      }
    }
  }
  for (const dir of dirs) await walk(dir, 0)
  return found
}

/** Config patch for the profile's default model. Sends only the keys that are being set. */
export function modelPatch(config, { model, provider }) {
  const current = config && typeof config.model === 'object' && config.model && !Array.isArray(config.model) ? { ...config.model } : {}
  const next = { ...current }
  if (typeof model === 'string' && model.trim()) next.default = model.trim().slice(0, 120)
  if (typeof provider === 'string' && provider.trim()) next.provider = provider.trim().slice(0, 60)
  if (next.default === current.default && next.provider === current.provider) return null
  if (!next.default) return { error: 'invalid' }
  return { config: { model: next } }
}
