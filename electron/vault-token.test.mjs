import { afterEach, describe, expect, it } from 'vitest'
import vault from './vault-token.cjs'

const { ENV_KEY, adoptEnvironmentVaultToken, currentVaultToken, envWithoutVaultToken, rememberVaultToken } = vault

const TOKEN = 'ab'.repeat(32)
const previous = globalThis.__hermesBotVaultToken

afterEach(() => {
  if (previous === undefined) delete globalThis.__hermesBotVaultToken
  else globalThis.__hermesBotVaultToken = previous
})

describe('vault token', () => {
  it('keeps a valid token on the global and refuses anything else', () => {
    expect(rememberVaultToken(TOKEN)).toBe(true)
    expect(currentVaultToken()).toBe(TOKEN)
    expect(globalThis.__hermesBotVaultToken).toBe(TOKEN)
    expect(rememberVaultToken('short')).toBe(false)
    expect(currentVaultToken()).toBe(TOKEN)
    expect(rememberVaultToken(`${TOKEN}\n`)).toBe(false)
  })

  it('moves an environment token into memory and deletes the variable', () => {
    const env = { PATH: '/usr/bin', [ENV_KEY]: TOKEN }
    expect(adoptEnvironmentVaultToken(env)).toBe(true)
    expect(env[ENV_KEY]).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
    expect(currentVaultToken()).toBe(TOKEN)
  })

  it('drops an invalid environment token without publishing it', () => {
    globalThis.__hermesBotVaultToken = ''
    const env = { [ENV_KEY]: 'not-a-token' }
    expect(adoptEnvironmentVaultToken(env)).toBe(false)
    expect(env[ENV_KEY]).toBeUndefined()
    expect(currentVaultToken()).toBe('')
  })

  it('gives children a copy that does not contain the token', () => {
    const source = { PATH: '/usr/bin', LANG: 'en_US.UTF-8', [ENV_KEY]: TOKEN }
    const child = envWithoutVaultToken(source)
    expect(child[ENV_KEY]).toBeUndefined()
    expect(child.PATH).toBe('/usr/bin')
    expect(source[ENV_KEY]).toBe(TOKEN)
  })
})
