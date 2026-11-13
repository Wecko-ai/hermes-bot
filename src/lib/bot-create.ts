import type { Bot } from '../types'
import type { HermesRpcError } from './hermes'
import { i18n } from '../i18n'
import { BotManageError, isRemovedProfile, updateBotCard } from './bot-manage'
import { newBotSoul } from './bot-kickoff'
import { UNASSIGNED_SECTION_ID, UNASSIGNED_SECTION_NAME } from './roster-groups'

/**
 * Creating a bot: a Hermes profile (`profiles.create`), then its card in the profile's `ui_meta`, as Hermes
 * Desktop does, so the bot looks the same in Hermes Desktop and in the iPhone app.
 */

type Json = Record<string, unknown>
/** What creation needs of the gateway connection (`HermesClient` has it); a fake in the tests. */
export type BotCreateClient = { request: (method: string, params?: Json, timeoutMs?: number) => Promise<any> }

// ── Profile name ────────────────────────────────────────────────────────────

/** Hermes' rule for a profile name (`hermes_constants.PROFILE_ID_RE`). */
const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const PROFILE_NAME_MAX = 64
/** Names Hermes refuses for a new profile (`hermes_cli.profiles._RESERVED_NAMES`); `default` is the main profile. */
export const RESERVED_PROFILE_NAMES: ReadonlySet<string> = new Set(['hermes', 'default', 'test', 'tmp', 'root', 'sudo'])
const LETTERS: Record<string, string> = { 'æ': 'ae', 'œ': 'oe', 'ß': 'ss', 'ø': 'o', 'ł': 'l', 'đ': 'd', 'ð': 'd', 'þ': 'th' }

/**
 * The profile name Hermes will get for a display name: lowercase, accents stripped, spaces and word separators
 * to `-`, anything else dropped, starting with a letter or a digit, 64 characters at most. Empty when nothing usable is left.
 */
export function profileNameFrom(displayName: string): string {
  const slug = displayName
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[æœßøłđðþ]/g, (letter) => LETTERS[letter])
    .replace(/[\s.,/\\:;+&|·–—]+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+/, '')
  return slug.slice(0, PROFILE_NAME_MAX).replace(/[-_]+$/, '')
}

/**
 * `invalid`: nothing usable for Hermes; `reserved`: a name Hermes keeps for itself; `removed`: a bot deleted from
 * this app keeps its profile under this name; `taken`: another profile has it.
 */
export type ProfileNameIssue = 'invalid' | 'reserved' | 'removed' | 'taken'

export interface KnownProfiles {
  /** Every profile name Hermes or the roster holds. */
  taken: ReadonlySet<string>
  /** Profiles deleted from this app (the reversible removal): still in Hermes. */
  removed: ReadonlySet<string>
}

export function profileNameIssue(slug: string, known: KnownProfiles): ProfileNameIssue | null {
  if (!PROFILE_ID.test(slug)) return 'invalid'
  if (RESERVED_PROFILE_NAMES.has(slug)) return 'reserved'
  if (known.removed.has(slug)) return 'removed'
  if (known.taken.has(slug)) return 'taken'
  return null
}

/** Every profile Hermes holds, the ones this app hides included (`default`, technical profiles, deleted bots). */
export async function loadProfileNames(client: BotCreateClient): Promise<KnownProfiles> {
  const result = await client.request('profiles.list', { include_sessions: false })
  const rows = (Array.isArray(result?.profiles) ? result.profiles : []).filter((row: unknown): row is Json => Boolean(row) && typeof row === 'object')
  const named = rows.filter((row: Json) => typeof row.name === 'string' && row.name)
  return {
    taken: new Set(named.map((row: Json) => row.name as string)),
    removed: new Set(named.filter((row: Json) => isRemovedProfile(row.ui_meta)).map((row: Json) => row.name as string)),
  }
}

// ── Look ────────────────────────────────────────────────────────────────────

/**
 * Colors offered, as `#RRGGBB`: Hermes Desktop paints any CSS color, the iPhone app reads hex, and these are the
 * colors this app gives a bot without one, so a new bot sits well among the others.
 */
export const BOT_COLORS = [
  { id: 'violet', value: '#7A63C9' },
  { id: 'blue', value: '#3B82C4' },
  { id: 'cyan', value: '#2BA6A0' },
  { id: 'green', value: '#3FA66B' },
  { id: 'yellow', value: '#E0A526' },
  { id: 'orange', value: '#E8833A' },
  { id: 'red', value: '#D9483B' },
  { id: 'magenta', value: '#C9559A' },
  { id: 'brown', value: '#9A6B4F' },
  { id: 'gray', value: '#7B8794' },
  { id: 'slate', value: '#2F4858' },
] as const

/** Shapes offered: the ones this app, Hermes Desktop (its drawn faces) and the iPhone app all draw alike. */
export const BOT_SHAPES = ['blob', 'pebble', 'squircle', 'round', 'hex', 'wedge', 'cloud', 'teardrop'] as const

/** Other names other apps write for the same shapes. */
const SHAPE_ALIASES: Record<string, string> = { blobatar: 'blob', organic: 'blob', boxy: 'squircle', circle: 'round', hexagon: 'hex', triangle: 'wedge', drop: 'teardrop' }
export const canonicalShape = (shape: string) => SHAPE_ALIASES[shape] ?? shape

/** The option the existing bots use least; the first one in the list when several tie. */
export function leastUsed<T extends string>(options: readonly T[], used: Iterable<string>): T {
  const counts = new Map(options.map((option) => [option.toLowerCase(), 0]))
  for (const value of used) {
    const key = value.toLowerCase()
    if (counts.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return options.reduce((best, option) => (counts.get(option.toLowerCase())! < counts.get(best.toLowerCase())! ? option : best), options[0])
}

// ── Creation ────────────────────────────────────────────────────────────────

export interface BotDraft {
  /** Display name, written to the card. */
  title: string
  /** Hermes profile name, derived from the display name. */
  slug: string
  color: string
  shape: string
}

/**
 * `unsupported`: the gateway does not know `profiles.create`; `invalid`, `reserved`, `taken`, `removed`: the name
 * (see `ProfileNameIssue`); `refused`: the gateway gave another reason; `offline`: no answer.
 */
export type BotCreateFailure = 'unsupported' | ProfileNameIssue | 'refused' | 'offline'

export class BotCreateError extends Error {
  constructor(public reason: BotCreateFailure, message: string = reason) {
    super(message)
    this.name = 'BotCreateError'
  }
}

export interface BotCreated {
  slug: string
  /** The profile exists but its card could not be written: the bot shows with a default look, unassigned. */
  cardError: BotManageError | null
  /** The gateway says no model can serve the bot yet (its reason); null when it can, or when the answer is unknown. */
  modelIssue: string | null
  /** `profiles.list` returned the new profile. */
  listed: boolean
}

/** As Hermes Desktop creates a bot: a new profile with the bundled skills, the launch profile's credentials and model (one shared sign-in), and its SOUL. */
export function createProfileParams(draft: BotDraft): Json {
  return { name: draft.slug, description: '', no_skills: false, share_auth: true, soul: newBotSoul(draft) }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
/** Waits between reads of the new profile, in ms: about 4 s in all. */
const LISTING_WAITS = [0, 250, 500, 1_000, 2_000]

const rpcCode = (error: unknown) => error instanceof Error && error.name === 'HermesRpcError' ? (error as HermesRpcError).code : undefined

async function creationError(client: BotCreateClient, slug: string, error: unknown): Promise<BotCreateError> {
  // By name, not `instanceof`: a value import of hermes.ts here would be a cycle (hermes.ts reads bot-kickoff).
  if (!(error instanceof Error) || error.name !== 'HermesRpcError') {
    return new BotCreateError('offline', error instanceof Error ? error.message : String(error))
  }
  const code = rpcCode(error)
  if (code === -32601) return new BotCreateError('unsupported', error.message)
  if (code === 4061) return new BotCreateError('invalid', error.message)
  if (code === 4062) {
    // Invalid, reserved or already there: the profiles Hermes holds now say which.
    if (RESERVED_PROFILE_NAMES.has(slug)) return new BotCreateError('reserved', error.message)
    const known = await loadProfileNames(client).catch(() => null)
    if (known?.removed.has(slug)) return new BotCreateError('removed', error.message)
    if (known?.taken.has(slug)) return new BotCreateError('taken', error.message)
  }
  return new BotCreateError('refused', error.message)
}

async function waitUntilListed(client: BotCreateClient, slug: string, wait: (ms: number) => Promise<void>) {
  for (const ms of LISTING_WAITS) {
    if (ms) await wait(ms)
    const known = await loadProfileNames(client).catch(() => null)
    if (known?.taken.has(slug)) return true
  }
  return false
}

/** `setup.runtime_check` for the new profile, as Hermes Desktop asks before the intro turn. Unknown answers never block. */
async function modelIssue(client: BotCreateClient, slug: string): Promise<string | null> {
  try {
    const result = await client.request('setup.runtime_check', { profile: slug }, 8_000)
    return result?.ok === false ? (typeof result.error === 'string' && result.error) || i18n.t('hermes.routeUnusable') : null
  } catch {
    return null
  }
}

/**
 * Creates the profile, waits until Hermes lists it, writes its card, then asks whether a model can serve it.
 * Rejects with a `BotCreateError` only when the profile was not created; after that every step is best effort.
 */
export async function createBot(client: BotCreateClient, draft: BotDraft, options: { wait?: (ms: number) => Promise<void>; now?: () => number } = {}): Promise<BotCreated> {
  const { wait = delay, now = Date.now } = options
  try {
    await client.request('profiles.create', createProfileParams(draft))
  } catch (error) {
    throw await creationError(client, draft.slug, error)
  }
  const listed = await waitUntilListed(client, draft.slug, wait)
  let cardError: BotManageError | null = null
  try {
    await updateBotCard(client, draft.slug, { title: draft.title, shape: draft.shape, color: draft.color, imageKind: 'shape', created: now() })
  } catch (error) {
    cardError = error instanceof BotManageError ? error : new BotManageError('offline', error instanceof Error ? error.message : String(error))
  }
  return { slug: draft.slug, cardError, modelIssue: await modelIssue(client, draft.slug), listed }
}

/** The roster row of a bot just created, until Hermes lists it with its card. */
export function createdBotEntry(draft: BotDraft, now = new Date()): Bot {
  return {
    slug: draft.slug,
    name: draft.title,
    role: i18n.t('hermes.defaultRole'),
    section: UNASSIGNED_SECTION_NAME,
    sectionId: UNASSIGNED_SECTION_ID,
    model: 'Hermes',
    status: 'idle',
    preview: '',
    timestamp: now.toISOString(),
    unread: 0,
    hidden: false,
    avatar: { shape: draft.shape, color: draft.color },
  }
}

/** The roster with the new bot in it, also when Hermes does not list it yet. */
export const withCreatedBot = (bots: Bot[], bot: Bot) => bots.some((item) => item.slug === bot.slug) ? bots : [...bots, bot]

/** A readable message for a failed creation, in the interface language. */
export function botCreateErrorText(error: unknown, slug: string): string {
  if (!(error instanceof BotCreateError)) return i18n.t('newBot.errors.offline')
  if (error.reason === 'invalid' || error.reason === 'reserved' || error.reason === 'taken' || error.reason === 'removed') return i18n.t(`newBot.issues.${error.reason}`, { slug })
  if (error.reason === 'refused') return i18n.t('newBot.errors.refused', { message: error.message })
  return i18n.t(`newBot.errors.${error.reason}`)
}
