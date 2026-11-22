import type { Bot, ModelOption } from '../types'
import { i18n } from '../i18n'
import { LOCAL_CHAT_SLUG } from './local-chat'

export type MemoryType = 'user' | 'behavior' | 'people' | 'workstream'
export const MEMORY_TYPES: MemoryType[] = ['user', 'behavior', 'people', 'workstream']

export interface MemoryFact {
  id: string
  type: MemoryType
  text: string
  learnedBy: string
  createdAt: string
  updatedAt: string
}

export interface PrivateMemory {
  profile: string
  store: 'memory' | 'user'
  text: string
}

export interface MemoryProviderInfo {
  profile: string
  provider: string
  bank: string
  active: boolean
}

export interface MemoryView {
  facts: MemoryFact[]
  unreadable: MemoryType[]
  providers: MemoryProviderInfo[]
  learned: PrivateMemory[]
}

export interface PublishRow {
  slug: string
  externalDir: 'present' | 'added' | 'failed'
  memory: 'same' | 'digest' | 'pointer' | 'unchanged' | 'failed'
}

export interface SkillInfo {
  name: string
  description: string
  category: string
  enabled: boolean
  scope: 'shared' | 'profile'
  path: string
  provenance: string
}

export interface HubSkill {
  name: string
  identifier: string
  description: string
  source: string
  installed: boolean
}

export interface ToolsetInfo {
  name: string
  label: string
  description: string
  enabled: boolean
  tools: string[]
}

export interface BotSheetData {
  persona: string
  personaVia: 'api' | 'file'
  model: string
  provider: string
  toolsets: ToolsetInfo[]
  toolsetsSupported: boolean
  toolsetsEditable: boolean
}

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceError'
  }
}

async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(path, {
    method: init?.method || 'GET',
    credentials: 'same-origin',
    headers: init?.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new WorkspaceError(typeof body?.error === 'string' ? body.error : 'workspace_failed')
  return body as T
}

export const profileSlugs = (bots: Bot[]) => bots.filter((bot) => bot.slug && bot.slug !== LOCAL_CHAT_SLUG).map((bot) => bot.slug)

export function workspaceErrorText(error: unknown) {
  const code = error instanceof Error ? error.message : 'workspace_failed'
  const key = `workspace.errors.${code}`
  return i18n.exists(key) ? i18n.t(key) : i18n.t('workspace.errors.workspace_failed')
}

export function learnerName(learnedBy: string, bots: Bot[]) {
  if (learnedBy === 'user') return i18n.t('workspace.learnedUser')
  if (!learnedBy || learnedBy === 'unknown') return i18n.t('workspace.learnedUnknown')
  return bots.find((bot) => bot.slug === learnedBy)?.name || learnedBy
}

export const loadMemory = (profiles: string[]) =>
  call<MemoryView>(`/api/workspace/memory?${new URLSearchParams({ profiles: profiles.join(',') })}`)

/** Points every listed profile at the shared files. Idempotent. */
export const publishMemory = (profiles: string[]) =>
  call<{ skill: string; profiles: PublishRow[] }>('/api/workspace/memory', { method: 'POST', body: { action: 'publish', profiles } })

export function changeMemory(body: { action: 'add' | 'update' | 'forget' | 'share'; profiles: string[]; id?: string; type?: MemoryType; text?: string; learnedBy?: string }) {
  return call<{ fact: MemoryFact | null; facts: MemoryFact[]; published: { skill: string; profiles: PublishRow[] } }>('/api/workspace/memory', { method: 'POST', body })
}

export const loadSkills = (profile: string) =>
  call<{ supported: boolean; source: string; skills: SkillInfo[]; error?: string }>(`/api/workspace/skills?${new URLSearchParams({ profile })}`)

export const loadSkillFile = (profile: string, name: string) =>
  call<{ name: string; path: string; text: string }>(`/api/workspace/skills/file?${new URLSearchParams({ profile, name })}`)

export const toggleSkill = (profile: string, name: string, enabled: boolean) =>
  call<{ ok: boolean; name: string; enabled: boolean }>('/api/workspace/skills/toggle', { method: 'PUT', body: { profile, name, enabled } })

export const searchSkillHub = (profile: string, query: string) =>
  call<{ supported: boolean; results: HubSkill[]; error?: string }>(`/api/workspace/skills/hub?${new URLSearchParams({ profile, q: query })}`)

export const installSkill = (profile: string, identifier: string) =>
  call<{ supported: boolean; ok: boolean; detail?: string }>('/api/workspace/skills/hub', { method: 'POST', body: { profile, identifier } })

export const loadBotSheet = (profile: string) =>
  call<BotSheetData>(`/api/workspace/bot?${new URLSearchParams({ profile })}`)

export function saveBotSheet(body: { profile: string; persona: string; model: string; provider: string; toolsets?: { name: string; enabled: boolean }[] }) {
  return call<{ ok: boolean; saved: { persona?: string; model?: string; toolsets?: { name: string; ok: boolean }[]; toolsetsPartial?: boolean } }>('/api/workspace/bot', { method: 'PUT', body })
}

/** The model row that matches a profile’s saved default, if the picker already has it. */
export function modelChoice(options: ModelOption[], model: string, provider: string) {
  return options.find((option) => option.model === model && (!provider || option.provider === provider)) || null
}
