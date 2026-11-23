import type { HermesClient } from './hermes'

export interface SkillItem {
  id: string
  folder: string
  scope: 'shared' | 'profile'
  shared: boolean
  name: string
  description: string
}

export interface SkillsCatalog {
  shared: SkillItem[]
  profile: SkillItem[]
  disabled: string[]
  hubInstallCommand: string
  hubManage?: boolean
}

export async function loadSkills(profile: string) {
  const response = await fetch(`/api/skills?${new URLSearchParams({ profile })}`, { credentials: 'same-origin', cache: 'no-store' })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(String(body.error || response.status))
  return body as SkillsCatalog
}

export async function installSkillFromHub(client: HermesClient, profile: string, skillId: string) {
  return client.request<{ installed?: boolean; name?: string }>('skills.manage', { profile, action: 'install', query: skillId.trim() })
}

export async function toggleSkill(profile: string, skillId: string, enabled: boolean) {
  const response = await fetch('/api/skills/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ profile, skillId, enabled }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(String(body.error || response.status))
  return body as { disabled: string[] }
}