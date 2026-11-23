import {
  creationError,
  type BotCreateClient,
  type BotCreated,
  type BotDraft,
  modelIssue,
  profileNameFrom,
  waitUntilListed,
} from './bot-create'
import { BotManageError, updateBotCard } from './bot-manage'
import { saveBotProfile } from './bot-profile'

export interface ImportedTemplate {
  soul: string
  configBody: { config?: Record<string, unknown> }
  card?: Record<string, unknown>
  profile?: string
}

export async function validateBotTemplate(file: File) {
  const text = await file.text()
  let template: unknown
  try {
    template = JSON.parse(text)
  } catch {
    throw new Error('invalid_json')
  }
  const response = await fetch('/api/bot-template/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ template }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(String(body.error || response.status))
  return {
    template,
    soul: String(body.soul || ''),
    configBody: body.configBody as ImportedTemplate['configBody'],
    card: (template as { card?: Record<string, unknown> })?.card,
    suggestedTitle: String((template as { card?: { title?: string } })?.card?.title || (template as { profile?: string })?.profile || ''),
  }
}

function templateToolsets(configBody: ImportedTemplate['configBody']) {
  const raw = configBody?.config?.toolsets as { enabled?: string[]; disabled?: string[] } | undefined
  if (!raw || typeof raw !== 'object') return { enabled: [] as string[], disabled: [] as string[] }
  return {
    enabled: Array.isArray(raw.enabled) ? raw.enabled.filter((item) => typeof item === 'string') : [],
    disabled: Array.isArray(raw.disabled) ? raw.disabled.filter((item) => typeof item === 'string') : [],
  }
}

function cardLook(card: Record<string, unknown> | undefined, draft: BotDraft) {
  const color = typeof card?.color === 'string' ? card.color : draft.color
  const shape = typeof card?.shape === 'string' ? card.shape : draft.shape
  const title = typeof card?.title === 'string' && card.title.trim() ? card.title.trim() : draft.title
  return { color, shape, title }
}

/** Create the Hermes profile, card, SOUL and toolsets after explicit confirmation. */
export async function createBotFromTemplate(
  client: BotCreateClient,
  draft: BotDraft,
  imported: ImportedTemplate & { card?: Record<string, unknown> },
): Promise<BotCreated> {
  try {
    await client.request('profiles.create', {
      name: draft.slug,
      description: '',
      no_skills: false,
      share_auth: true,
      soul: imported.soul,
    })
  } catch (error) {
    throw await creationError(client, draft.slug, error)
  }
  const listed = await waitUntilListed(client, draft.slug)
  const look = cardLook(imported.card, draft)
  let cardError: BotManageError | null = null
  try {
    await updateBotCard(client, draft.slug, {
      title: look.title || draft.title,
      shape: look.shape,
      color: look.color,
      imageKind: 'shape',
      created: Date.now(),
    })
  } catch (error) {
    cardError = error instanceof BotManageError ? error : new BotManageError('offline', error instanceof Error ? error.message : String(error))
  }
  const toolsets = templateToolsets(imported.configBody)
  if (toolsets.enabled.length || toolsets.disabled.length) {
    await saveBotProfile(draft.slug, { soul: imported.soul, previousSoul: imported.soul, toolsets }, true)
  }
  return {
    slug: draft.slug,
    cardError,
    modelIssue: await modelIssue(client, draft.slug),
    listed,
  }
}

export function slugFromTemplateTitle(title: string) {
  return profileNameFrom(title)
}