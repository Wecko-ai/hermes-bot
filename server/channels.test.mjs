import { describe, expect, it } from 'vitest'
import {
  backupPath, channelStatusFromKeys, envKeysPresent, mergeEnvText, validateChannelEnvBody, validateChannelRequest,
} from './channels.mjs'

describe('channels.mjs', () => {
  it('records only key names from env text', () => {
    const keys = envKeysPresent('TELEGRAM_BOT_TOKEN=secret\n# comment\nEMPTY=\nSLACK_BOT_TOKEN=x')
    expect([...keys].sort()).toEqual(['SLACK_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN'])
  })

  it('never logs values in status output', () => {
    const status = channelStatusFromKeys(['TELEGRAM_BOT_TOKEN'])
    expect(status.snippet).toContain('TELEGRAM_BOT_TOKEN')
    expect(status.snippet).not.toContain('secret')
    expect(status.platforms.find((item) => item.platform === 'telegram')?.ready).toBe(true)
  })

  it('validates apply requests', () => {
    expect(validateChannelRequest({ profile: 'orion', platform: 'telegram' })).toEqual({ profile: 'orion', platform: 'telegram' })
    expect(validateChannelRequest({ profile: '../x', platform: 'telegram' })).toBeNull()
  })

  it('merges env text without echoing previous values in status output', () => {
    const merged = mergeEnvText('# existing\nOLD_KEY=keep\n', { TELEGRAM_BOT_TOKEN: 'abc', TELEGRAM_ALLOWED_USERS: '123' })
    expect(merged).toContain('TELEGRAM_BOT_TOKEN=abc')
    expect(merged).toContain('OLD_KEY=keep')
    const status = channelStatusFromKeys([...envKeysPresent(merged)])
    expect(status.snippet).toContain('TELEGRAM_BOT_TOKEN')
    expect(status.snippet).not.toContain('abc')
  })

  it('accepts partial slack env writes', () => {
    expect(validateChannelEnvBody({
      profile: 'orion',
      platform: 'slack',
      env: { SLACK_APP_TOKEN: 'xapp-test' },
    })).toMatchObject({ platform: 'slack', env: { SLACK_APP_TOKEN: 'xapp-test' } })
    expect(validateChannelEnvBody({
      profile: 'orion',
      platform: 'slack',
      env: { NOT_ALLOWED: 'x' },
    })).toBeNull()
  })

  it('builds backup paths with timestamps', () => {
    expect(backupPath('/tmp/profile/.env', 0)).toMatch(/\.env\.bak-1970-01-01T00-00-00-000Z$/)
  })
})