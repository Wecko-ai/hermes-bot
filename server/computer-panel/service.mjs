import { loadChromeTeams } from '../chrome-teams.mjs'
import { readBrowserTurns } from '../browser-turn.mjs'
import { ComputerPanelError } from './errors.mjs'
import {
  cdpTargetForBot,
  driverForBot,
  normalizeBotSlug,
  listPages,
  resolveCdpOrigin,
  teamForBot,
} from './chrome.mjs'
import { hubForOrigin, resetScreencastHubs } from './hub.mjs'

const STEER_CAPTURE = `[HermesBot computer panel] The user took control of the team Chrome for human verification (for example a CAPTCHA). Pause browser automation and do not click or type in that browser until they release control. Keep the same tab in front.`

const STEER_RELEASE = `[HermesBot computer panel] The user released control of the team Chrome. Resume automation from the current page state.`

export function createComputerPanelService(options = {}) {
  const enabled = options.enabled === true
  const teams = options.chromeTeams !== undefined
    ? options.chromeTeams
    : loadChromeTeams(options.chromeTeamsFile || '')
  const cdpOverride = options.cdpOrigin || ''
  const browserTurnCommand = options.browserTurnCommand || null

  async function originForBot(bot) {
    const origin = resolveCdpOrigin(teams, bot, cdpOverride)
    if (!origin) throw new ComputerPanelError('chrome_unconfigured', 503)
    return origin
  }

  async function liveTurnContext(slug) {
    const turns = browserTurnCommand ? await readBrowserTurns(browserTurnCommand) : []
    const driver = driverForBot(teams, slug, turns)
    return { turns, driver, targetId: cdpTargetForBot(turns, driver) }
  }

  async function statusForBot(bot) {
    const slug = normalizeBotSlug(bot)
    if (!slug) throw new ComputerPanelError('invalid_request', 400)
    const origin = await originForBot(slug)
    const { driver, targetId } = await liveTurnContext(slug)
    const hub = hubForOrigin(origin)
    hub.setPreferredTarget(targetId)
    hub.setDriver(driver)
    return { enabled: true, origin, driver, ...hub.meta }
  }

  function attachStream(bot, response) {
    const slug = normalizeBotSlug(bot)
    if (!slug) throw new ComputerPanelError('invalid_request', 400)
    return originForBot(slug).then(async (origin) => {
      const hub = hubForOrigin(origin)
      const { targetId } = await liveTurnContext(slug).catch(() => ({ targetId: '' }))
      hub.setPreferredTarget(targetId)
      const onEvent = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`)
      void statusForBot(slug).catch(() => undefined)
      const detach = hub.attach(slug, onEvent)
      return { detach, hub, origin }
    })
  }

  async function setTakeover(bot, active) {
    const slug = normalizeBotSlug(bot)
    if (!slug) throw new ComputerPanelError('invalid_request', 400)
    const origin = await originForBot(slug)
    const hub = hubForOrigin(origin)
    hub.setUserControlled(slug, active === true)
    return {
      userControlled: hub.isUserControlled(slug),
      steerText: active ? STEER_CAPTURE : STEER_RELEASE,
    }
  }

  async function forwardInput(bot, body) {
    const slug = normalizeBotSlug(bot)
    if (!slug) throw new ComputerPanelError('invalid_request', 400)
    const origin = await originForBot(slug)
    const hub = hubForOrigin(origin)
    await hub.input(slug, body)
    return { ok: true }
  }

  /** The tabs of the bot's team Chrome, the one on screen marked. */
  async function pagesForBot(bot) {
    const slug = normalizeBotSlug(bot)
    if (!slug) throw new ComputerPanelError('invalid_request', 400)
    const origin = await originForBot(slug)
    const hub = hubForOrigin(origin)
    const pages = await listPages(origin)
    const current = hub.currentTargetId
    const team = cdpOverride ? null : teamForBot(teams, slug)
    return {
      team: team ? team.label : '',
      following: !hub.manualTargetId,
      pages: pages.map((page) => ({
        id: String(page.id || ''),
        title: String(page.title || '').slice(0, 200),
        url: String(page.url || '').slice(0, 500),
        current: Boolean(current) && page.id === current,
      })).filter((page) => page.id),
    }
  }

  async function selectPage(bot, targetId) {
    const slug = normalizeBotSlug(bot)
    if (!slug) throw new ComputerPanelError('invalid_request', 400)
    const origin = await originForBot(slug)
    const id = String(targetId || '')
    if (id && !(await listPages(origin)).some((page) => page.id === id)) throw new ComputerPanelError('unknown_tab', 404)
    await hubForOrigin(origin).selectTarget(id)
    return pagesForBot(slug)
  }

  function controlFlag(bot) {
    const slug = normalizeBotSlug(bot)
    if (!slug) return { userControlled: false }
    try {
      const origin = resolveCdpOrigin(teams, slug, cdpOverride)
      if (!origin) return { userControlled: false }
      const hub = hubForOrigin(origin)
      return { userControlled: hub.isUserControlled(slug) || hub.meta.userControlled }
    } catch {
      return { userControlled: false }
    }
  }

  return {
    enabled,
    statusForBot,
    attachStream,
    setTakeover,
    forwardInput,
    pagesForBot,
    selectPage,
    controlFlag,
    steerTexts: { capture: STEER_CAPTURE, release: STEER_RELEASE },
    reset: resetScreencastHubs,
  }
}