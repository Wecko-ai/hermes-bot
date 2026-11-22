export type SkillScope = 'shared' | 'bot'
export type SkillProvenance = 'hub' | 'bundled' | 'external' | 'agent'

export interface LibrarySkill {
  name: string
  description: string
  scope: SkillScope
  enabled: boolean
  provenance: SkillProvenance
}

export interface HubSkill {
  identifier: string
  name: string
  description: string
  category: string
  trust: 'reviewed' | 'community'
  installed: boolean
}

async function send<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(typeof body.message === 'string' && body.message ? body.message : 'rejected') as Error & { code?: string }
    error.code = typeof body.error === 'string' ? body.error : 'rejected'
    throw error
  }
  return body as T
}

export function loadSkills(profile = '') {
  const query = profile ? `?${new URLSearchParams({ profile })}` : ''
  return send<{ unsupported: boolean; skills: LibrarySkill[] }>(`/api/skills/library${query}`)
}

export function loadSkillText(name: string, profile = '') {
  const query = new URLSearchParams({ name, ...(profile ? { profile } : {}) })
  return send<{ name: string; content: string }>(`/api/skills/library/content?${query}`)
}

export function setSkillEnabled(name: string, profile: string, enabled: boolean) {
  return send<{ ok: boolean }>('/api/skills/library/enabled', { method: 'PUT', body: JSON.stringify({ name, profile, enabled }) })
}

export function loadHub(query = '', profile = '') {
  const params = new URLSearchParams()
  if (query) params.set('q', query)
  if (profile) params.set('profile', profile)
  const search = params.toString()
  return send<{ unsupported: boolean; skills: HubSkill[] }>(`/api/skills/hub${search ? `?${search}` : ''}`)
}

export function installHubSkill(identifier: string, profile = '') {
  const payload: { identifier: string; profile?: string } = { identifier }
  if (profile) payload.profile = profile
  return send<{ ok: boolean; background: boolean }>('/api/skills/hub/install', { method: 'POST', body: JSON.stringify(payload) })
}

export function splitSkills(skills: LibrarySkill[]) {
  return {
    shared: skills.filter((skill) => skill.scope === 'shared'),
    bot: skills.filter((skill) => skill.scope === 'bot'),
  }
}

/** Fictional skills for the visual demo. */
export function demoSkills(): LibrarySkill[] {
  return [
    { name: 'mail-approval', description: 'Show a mail and wait for approval before sending it.', scope: 'shared', enabled: true, provenance: 'bundled' },
    { name: 'places', description: 'Look up nearby places.', scope: 'shared', enabled: false, provenance: 'hub' },
    { name: 'weekly-notes', description: 'A note this bot keeps for itself.', scope: 'bot', enabled: true, provenance: 'agent' },
  ]
}

export const DEMO_SKILL_TEXT = '# Weekly notes\n\nKeep a short list of what this bot finished this week.\n'
