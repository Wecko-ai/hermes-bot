import { describe, expect, it } from 'vitest'
import { CHANNEL_GUIDES, buildProfileStatus, channelReady, channelSnippet } from './channels'

describe('channels', () => {
  it('marks telegram ready when the token key is present', () => {
    const guide = CHANNEL_GUIDES.find((item) => item.id === 'telegram')!
    const state = channelReady(guide, new Set(['TELEGRAM_BOT_TOKEN']))
    expect(state.ready).toBe(true)
    expect(state.missingRequired).toEqual([])
  })

  it('never puts secret-like values in the snippet', () => {
    const guide = CHANNEL_GUIDES[0]
    const snippet = channelSnippet(guide, new Set())
    expect(snippet).toMatch(/TELEGRAM_BOT_TOKEN/)
    expect(snippet).not.toMatch(/123456|ABCdef/)
  })

  it('builds per-platform status from key names only', () => {
    const status = buildProfileStatus('orion', ['TELEGRAM_BOT_TOKEN', 'SLACK_BOT_TOKEN'])
    expect(status.profile).toBe('orion')
    expect(status.platforms.find((item) => item.platform === 'telegram')?.ready).toBe(true)
    expect(status.platforms.find((item) => item.platform === 'slack')?.ready).toBe(false)
    expect(status.platforms.find((item) => item.platform === 'imessage')?.ready).toBe(false)
  })
})