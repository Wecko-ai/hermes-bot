import type { Bot } from '../types'
import { updateBotCard, type BotManageClient } from './bot-manage'

export interface BotProfileDraft {
  soul: string
  toolsets: { enabled: string[]; disabled: string[] }
  model: { provider: string; default: string; label: string }
}

export interface BotProfilePreview {
  soul: Array<{ kind: 'same' | 'add' | 'remove'; text: string }>
}

export async function loadBotProfile(profile: string) {
  const response = await fetch(`/api/bot-profile?${new URLSearchParams({ profile })}`, { credentials: 'same-origin', cache: 'no-store' })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(String(body.error || response.status))
  return body as BotProfileDraft & { profile: string }
}

export async function previewBotProfile(profile: string, draft: Partial<BotProfileDraft> & { previousSoul?: string }) {
  const response = await fetch(`/api/bot-profile?${new URLSearchParams({ profile })}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ ...draft, confirm: false }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(String(body.error || response.status))
  return body as { preview: BotProfilePreview; requiresConfirm: boolean }
}

export async function saveBotProfile(profile: string, draft: Partial<BotProfileDraft> & { previousSoul?: string }, confirm = true) {
  const response = await fetch(`/api/bot-profile?${new URLSearchParams({ profile })}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ ...draft, confirm }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(String(body.error || response.status))
  return body as { ok: boolean; preview: BotProfilePreview }
}

export async function exportBotTemplate(profile: string) {
  const response = await fetch(`/api/bot-template?${new URLSearchParams({ profile })}`, { credentials: 'same-origin', cache: 'no-store' })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(String(body.error || response.status))
  return body
}

export function downloadTemplate(filename: string, data: unknown) {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export async function saveBotAvatar(client: BotManageClient, bot: Bot, changes: Partial<{ color: string; shape: string }>) {
  await updateBotCard(client, bot.slug, {
    title: bot.name,
    description: bot.role,
    sectionId: bot.sectionId,
    sectionName: bot.section,
    color: changes.color ?? bot.avatar?.color,
    shape: changes.shape ?? bot.avatar?.shape,
    hidden: bot.hidden,
  })
}