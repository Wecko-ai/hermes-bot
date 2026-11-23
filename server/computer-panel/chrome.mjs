import { cdpOriginForBot } from '../chrome-teams.mjs'
import { assertLoopbackHttpOrigin, allowedDebuggerSocket } from './cdp-connection.mjs'
import { ComputerPanelError } from './errors.mjs'

const SLUG = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

export function normalizeBotSlug(slug) {
  const value = String(slug || '').trim()
  return SLUG.test(value) ? value : ''
}

export function resolveCdpOrigin(teams, bot, override = '') {
  if (override) return assertLoopbackHttpOrigin(override).origin
  const origin = cdpOriginForBot(teams, bot)
  if (!origin) return ''
  return assertLoopbackHttpOrigin(origin).origin
}

/** Team record for a bot slug, when a teams file is configured. */
export function teamForBot(teams, bot) {
  if (!teams) return null
  const own = Object.values(teams.teams).find((team) => team.bots.includes(bot))
  return own || teams.teams[teams.defaultTeam] || null
}

/** Bot that currently holds the browser turn for this bot's team Chrome. */
export function driverForBot(teams, bot, turns) {
  const team = teamForBot(teams, bot)
  if (!team) return turns[0]?.owner || ''
  const roster = new Set(team.bots)
  return turns.find((turn) => roster.has(turn.owner))?.owner || ''
}

export async function listPages(origin) {
  const base = assertLoopbackHttpOrigin(origin)
  try {
    const response = await fetch(new URL('/json/list', base), {
      signal: AbortSignal.timeout(3000),
      redirect: 'manual',
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) throw new ComputerPanelError('cdp_unavailable', 503)
    const targets = await response.json()
    const port = base.port || '80'
    return Array.isArray(targets)
      ? targets.filter((item) => item?.type === 'page' && allowedDebuggerSocket(item.webSocketDebuggerUrl, port))
      : []
  } catch (error) {
    if (error instanceof ComputerPanelError) throw error
    throw new ComputerPanelError('cdp_unavailable', 503)
  }
}

/** Prefer the active browser tab when its CDP target id is known, else a normal web page over chrome://. */
export function pickPage(pages, preferredTargetId = '') {
  const prefer = String(preferredTargetId || '').trim()
  if (prefer) {
    const match = pages.find((page) => page?.id === prefer)
    if (match) return match
  }
  const visible = pages.filter((page) => typeof page.url === 'string' && !page.url.startsWith('chrome://'))
  return visible[0] || pages[0] || null
}

/** CDP target id for the bot that currently holds the browser turn on this team, when the arbiter reports it. */
export function cdpTargetForBot(turns, driver) {
  const owner = String(driver || '').trim()
  if (!owner) return ''
  return turns.find((turn) => turn.owner === owner)?.targetId || ''
}

export async function pageMeta(connection) {
  const result = await connection.call('Runtime.evaluate', {
    expression: '({ url: location.href, title: document.title })',
    returnByValue: true,
    awaitPromise: false,
  })
  const value = result.result?.value
  if (!value || typeof value !== 'object') return { url: '', title: '' }
  return { url: String(value.url || ''), title: String(value.title || '') }
}