/**
 * Messaging channel setup (Telegram, Slack, iMessage). Env var names only — never values.
 * Status is inferred from which keys exist in a profile `.env`, via the local server.
 */

export type ChannelPlatform = 'telegram' | 'slack' | 'imessage'

export interface ChannelEnvVar {
  name: string
  required: boolean
}

export interface ChannelGuide {
  id: ChannelPlatform
  titleKey: string
  stepsKey: string
  env: ChannelEnvVar[]
  /** Non-secret config keys the wizard may write when `channels.wizardWrites` is on. */
  configPatch: Record<string, unknown>
}

export const CHANNEL_GUIDES: ChannelGuide[] = [
  {
    id: 'telegram',
    titleKey: 'channels.telegram.title',
    stepsKey: 'channels.telegram.steps',
    env: [
      { name: 'TELEGRAM_BOT_TOKEN', required: true },
      { name: 'TELEGRAM_ALLOWED_USERS', required: false },
      { name: 'TELEGRAM_HOME_CHANNEL', required: false },
      { name: 'TELEGRAM_REPLY_TO_MODE', required: false },
    ],
    configPatch: { platforms: { telegram: { enabled: true } } },
  },
  {
    id: 'slack',
    titleKey: 'channels.slack.title',
    stepsKey: 'channels.slack.steps',
    env: [
      { name: 'SLACK_BOT_TOKEN', required: true },
      { name: 'SLACK_APP_TOKEN', required: true },
      { name: 'SLACK_ALLOWED_USERS', required: false },
      { name: 'SLACK_HOME_CHANNEL', required: false },
    ],
    configPatch: { platforms: { slack: { enabled: true } } },
  },
  {
    id: 'imessage',
    titleKey: 'channels.imessage.title',
    stepsKey: 'channels.imessage.steps',
    env: [
      { name: 'BLUEBUBBLES_SERVER_URL', required: true },
      { name: 'BLUEBUBBLES_PASSWORD', required: true },
      { name: 'BLUEBUBBLES_ALLOWED_USERS', required: false },
      { name: 'BLUEBUBBLES_HOME_CHANNEL', required: false },
    ],
    configPatch: { platforms: { bluebubbles: { enabled: true } } },
  },
]

export interface ChannelPlatformStatus {
  platform: ChannelPlatform
  ready: boolean
  missingRequired: string[]
  present: string[]
}

export interface ChannelProfileStatus {
  profile: string
  platforms: ChannelPlatformStatus[]
  snippet: string
}

const SECRET_IN_SNIPPET = /(?:token|password|secret|api[_-]?key)\s*:/i

export function channelReady(guide: ChannelGuide, present: Set<string>) {
  const missingRequired = guide.env.filter((item) => item.required && !present.has(item.name)).map((item) => item.name)
  return { ready: missingRequired.length === 0, missingRequired, present: guide.env.filter((item) => present.has(item.name)).map((item) => item.name) }
}

/** YAML-style snippet for the operator; env values are never included. */
export function channelSnippet(guide: ChannelGuide, present: Set<string>) {
  const lines = [`# ${guide.id}`, '# Set these in the profile .env (names only; values stay on the gateway machine):']
  for (const item of guide.env) {
    const mark = present.has(item.name) ? 'ok' : item.required ? 'required' : 'optional'
    lines.push(`#   ${item.name} (${mark})`)
  }
  lines.push('# Non-secret profile config (applied only when channel wizard writes are enabled):')
  lines.push(`# ${JSON.stringify(guide.configPatch)}`)
  return lines.join('\n')
}

export function buildProfileStatus(profile: string, presentKeys: string[]): ChannelProfileStatus {
  const present = new Set(presentKeys)
  const platforms = CHANNEL_GUIDES.map((guide) => {
    const state = channelReady(guide, present)
    return { platform: guide.id, ready: state.ready, missingRequired: state.missingRequired, present: state.present }
  })
  const snippet = CHANNEL_GUIDES.map((guide) => channelSnippet(guide, present)).join('\n\n')
  if (SECRET_IN_SNIPPET.test(snippet)) throw new Error('unsafe_snippet')
  return { profile, platforms, snippet }
}

export async function fetchChannelStatus(profile: string): Promise<ChannelProfileStatus> {
  const response = await fetch(`/api/channels/status?${new URLSearchParams({ profile })}`, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`channels_status_${response.status}`)
  return response.json() as Promise<ChannelProfileStatus>
}

export async function applyChannelConfig(profile: string, platform: ChannelPlatform): Promise<{ ok: boolean; error?: string }> {
  const response = await fetch('/api/channels/apply', {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile, platform }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) return { ok: false, error: typeof body.error === 'string' ? body.error : `channels_apply_${response.status}` }
  return { ok: body.ok === true }
}

export async function writeChannelEnv(profile: string, platform: ChannelPlatform, env: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
  const response = await fetch('/api/channels/env', {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile, platform, env }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) return { ok: false, error: typeof body.error === 'string' ? body.error : `channels_env_${response.status}` }
  return { ok: body.ok === true }
}