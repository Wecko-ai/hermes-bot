import type { HermesRpcError } from './hermes'

/**
 * Managing a bot through its Hermes profile: the card the apps share (`ui_meta`), written with the gateway's
 * per-key compare-and-swap (`profiles.configure` + `ui_meta_expected_revisions`).
 *
 * Hermes Desktop owns the `hermes-bots` card format; this app and the iPhone app read the same card, so every
 * write here keeps the fields it does not know and only changes the ones it was asked to.
 */

type Json = Record<string, unknown>
/** What these helpers need of the gateway connection (`HermesClient` has it); a fake in the tests. */
export type BotManageClient = { request: (method: string, params?: Json) => Promise<any> }
type Client = BotManageClient

/** The card of a bot in its profile's `ui_meta` (profile.yaml), as Hermes Desktop writes it. */
export const BOT_CARD_KEY = 'hermes-bots'
/**
 * Set by Delete: the bot leaves this app's roster, its Hermes profile stays untouched. It keeps the card as it was
 * just before, with the date, so the bot can be brought back as it was (`restoreBot`).
 */
export const REMOVED_KEY = 'hermesbot-removed'

/** Fields of the `hermes-bots` card this app reads or writes. Others are kept as they are. */
export interface BotCard {
  /** Display name. The profile name (slug) never changes. */
  title?: string
  description?: string
  /** Section the bot is filed under. Membership lives on the bot; the name rides along so any app can rebuild the section. */
  sectionId?: string | null
  sectionName?: string | null
  shape?: string
  color?: string
  hidden?: boolean
  /** Creation time in milliseconds. */
  created?: number
  [key: string]: unknown
}

export interface RemovedMark {
  removed_at: string
  /** The card before the removal; null when the profile had none. */
  card: BotCard | null
}

export interface BotSection {
  id: string
  name: string
}

export interface ProfileMeta {
  name: string
  uiMeta: Json
  /** Per-key revisions; null on a gateway that predates the compare-and-swap. */
  revisions: Record<string, number> | null
}

/**
 * `unsupported`: the gateway does not know the method (or answers without its contract); `not_found`: no such
 * profile; `conflict`: another app kept writing the same key; `rejected`: the gateway answered but did not write;
 * `refused`: the gateway returned an error; `offline`: no answer.
 */
export type BotManageFailure = 'unsupported' | 'not_found' | 'conflict' | 'rejected' | 'refused' | 'offline'

export class BotManageError extends Error {
  constructor(public reason: BotManageFailure, message: string = reason) {
    super(message)
    this.name = 'BotManageError'
  }
}

const asObject = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {})
const isObject = (value: unknown): value is Json => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

async function call(client: Client, method: string, params: Json): Promise<unknown> {
  try {
    return await client.request(method, params)
  } catch (error) {
    // By name, not `instanceof`: hermes.ts reads `isRemovedProfile` from here, a value import back would be a cycle.
    if (error instanceof Error && error.name === 'HermesRpcError') {
      throw new BotManageError((error as HermesRpcError).code === -32601 ? 'unsupported' : 'refused', error.message)
    }
    throw new BotManageError('offline', error instanceof Error ? error.message : String(error))
  }
}

function cleanRevisions(value: unknown): Record<string, number> | null {
  if (!isObject(value)) return null
  return Object.fromEntries(Object.entries(value).flatMap(([key, revision]) =>
    typeof revision === 'number' && Number.isInteger(revision) ? [[key, Math.max(0, revision)]] : []))
}

/** The profile's `ui_meta` and revisions as the gateway holds them now (never from a cached roster). */
export async function readProfileMeta(client: Client, slug: string): Promise<ProfileMeta> {
  const result = asObject(await call(client, 'profiles.list', { include_sessions: false }))
  const row = (Array.isArray(result.profiles) ? result.profiles : []).map(asObject).find((profile) => profile.name === slug)
  if (!row) throw new BotManageError('not_found')
  return { name: slug, uiMeta: asObject(row.ui_meta), revisions: cleanRevisions(row.ui_meta_revisions) }
}

/**
 * Writes some `ui_meta` keys of a profile; a `null` value deletes the key. `build` receives the profile as the
 * gateway holds it at write time and returns the keys to write, so a change is always made on the latest card.
 * If another app wrote one of these keys in between, the gateway refuses the whole write: the profile is read
 * again and `build` runs once more (`attempts` in all).
 */
export async function writeUiMeta(client: Client, slug: string, build: (meta: ProfileMeta) => Json, attempts = 2): Promise<Record<string, number>> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const meta = await readProfileMeta(client, slug)
    const patch = build(meta)
    const params: Json = { name: slug, ui_meta: patch }
    if (meta.revisions) params.ui_meta_expected_revisions = Object.fromEntries(Object.keys(patch).map((key) => [key, meta.revisions?.[key] ?? 0]))
    const result = asObject(await call(client, 'profiles.configure', params))
    // An older gateway answers without the `applied` contract: nothing says the card was written.
    if (!isObject(result.applied)) throw new BotManageError('unsupported')
    const applied = result.applied
    if (applied.ui_meta === true) return cleanRevisions(applied.ui_meta_revisions) ?? {}
    if (isObject(applied.ui_meta_conflicts)) continue
    throw new BotManageError('rejected')
  }
  throw new BotManageError('conflict')
}

/** The bot's card in a profile's `ui_meta`; empty when it has none. */
export const botCard = (meta: Pick<ProfileMeta, 'uiMeta'>): BotCard => ({ ...asObject(meta.uiMeta[BOT_CARD_KEY]) })

/** Changes some fields of the card and keeps all the others, those of other apps included. */
export function updateBotCard(client: Client, slug: string, changes: BotCard) {
  return writeUiMeta(client, slug, (meta) => ({ [BOT_CARD_KEY]: { ...botCard(meta), ...changes } }))
}

/** Display name only: the profile, its folder and its slug stay as they are. */
export function renameBot(client: Client, slug: string, title: string) {
  const clean = title.trim()
  if (!clean) return Promise.reject(new BotManageError('rejected'))
  return updateBotCard(client, slug, { title: clean })
}

/** Files the bot under a section; `null` leaves it unassigned. */
export function moveBotToSection(client: Client, slug: string, section: BotSection | null) {
  return updateBotCard(client, slug, { sectionId: section?.id ?? null, sectionName: section?.name ?? null })
}

/** Hidden from the sidebars of every app that reads the card; the bot keeps working. */
export function setBotHidden(client: Client, slug: string, hidden: boolean) {
  return updateBotCard(client, slug, { hidden })
}

/**
 * Takes the bot out of this app's roster without touching its profile, its files, its history or its jobs.
 * The card gets `hidden` so other apps put it away too; the card as it was is kept under `REMOVED_KEY`.
 */
export function removeBot(client: Client, slug: string, now: Date = new Date()) {
  return writeUiMeta(client, slug, (meta) => {
    const previous = meta.uiMeta[REMOVED_KEY]
    // Removed twice (another window still showed it): the first mark keeps the card from before.
    const card = isObject(previous) ? asObject(previous).card : isObject(meta.uiMeta[BOT_CARD_KEY]) ? botCard(meta) : null
    const mark: RemovedMark = { removed_at: now.toISOString(), card: isObject(card) ? card as BotCard : null }
    return { [BOT_CARD_KEY]: { ...botCard(meta), hidden: true }, [REMOVED_KEY]: mark }
  })
}

/** Undoes `removeBot`: the card comes back exactly as it was before the removal. */
export function restoreBot(client: Client, slug: string) {
  return writeUiMeta(client, slug, (meta) => {
    const mark = meta.uiMeta[REMOVED_KEY]
    if (!isObject(mark)) return { [BOT_CARD_KEY]: { ...botCard(meta), hidden: false } }
    return { [BOT_CARD_KEY]: isObject(mark.card) ? mark.card : null, [REMOVED_KEY]: null }
  })
}

/** A profile removed from this app's roster (see `removeBot`). */
export const isRemovedProfile = (uiMeta: unknown) => isObject(asObject(uiMeta)[REMOVED_KEY])

/** A new section id, in the form Hermes Desktop uses. */
export const newSectionId = () => `sec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
