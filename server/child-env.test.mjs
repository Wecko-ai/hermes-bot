import { describe, expect, it } from 'vitest'
import { childEnv } from './child-env.mjs'

describe('childEnv', () => {
  it('copies the parent environment without the vault admin token', () => {
    const env = childEnv({ PATH: '/bin', HERMESBOT_VAULT_TOKEN: 'ab'.repeat(32), HOME: '/tmp' })
    expect(env.PATH).toBe('/bin')
    expect(env.HOME).toBe('/tmp')
    expect(env.HERMESBOT_VAULT_TOKEN).toBeUndefined()
    expect('HERMESBOT_VAULT_TOKEN' in env).toBe(false)
  })
})
