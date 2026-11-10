import { readFileSync } from 'node:fs'

const SLUG = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/**
 * Reads the bots' Chrome teams (one Chrome per team, each on its own CDP port).
 * Returns `null` if the file is missing or invalid: the caller then falls back to the single Chrome.
 */
export function loadChromeTeams(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object' || !raw.teams || typeof raw.teams !== 'object' || Array.isArray(raw.teams)) return null
    const teams = {}
    for (const [name, team] of Object.entries(raw.teams)) {
      if (!SLUG.test(name) || !team || typeof team !== 'object') return null
      const port = team.port
      if (!Number.isInteger(port) || port < 1024 || port > 65535) return null
      const bots = team.bots === undefined ? [] : team.bots
      if (!Array.isArray(bots) || !bots.every((bot) => typeof bot === 'string' && SLUG.test(bot))) return null
      teams[name] = { label: typeof team.label === 'string' ? team.label : name, port, bots }
    }
    const defaultTeam = raw.default_team
    if (typeof defaultTeam !== 'string' || !teams[defaultTeam]) return null
    return { defaultTeam, teams }
  } catch {
    return null
  }
}

/** CDP origin of a bot's Chrome: its team, otherwise the default team. Empty without a teams file. */
export function cdpOriginForBot(teams, slug) {
  if (!teams) return ''
  const own = Object.values(teams.teams).find((team) => team.bots.includes(slug))
  const team = own || teams.teams[teams.defaultTeam]
  return team ? `http://127.0.0.1:${team.port}` : ''
}
