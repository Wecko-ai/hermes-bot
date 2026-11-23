import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HERMESBOT_GATEWAY_METHODS, REQUIRED_GATEWAY_METHODS } from './gateway-contract'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const e2eSource = readFileSync(join(root, 'tests/e2e.mjs'), 'utf8')

function simulatedImplements(method: string): boolean {
  const patterns = [
    `frame.method === '${method}'`,
    `frame.method === "${method}"`,
    `'${method}'`,
  ]
  return patterns.some((pattern) => e2eSource.includes(pattern))
}

describe('gateway contract', () => {
  it('lists unique methods', () => {
    const names = HERMESBOT_GATEWAY_METHODS.map((row) => row.method)
    expect(names.length).toBe(new Set(names).size)
  })

  it('requires every mandatory method in the simulated gateway', () => {
    const missing = REQUIRED_GATEWAY_METHODS.filter((method) => !simulatedImplements(method))
    expect(missing).toEqual([])
  })

  it('implements room methods in the simulated gateway', () => {
    const roomMethods = HERMESBOT_GATEWAY_METHODS.filter((row) => row.requirement === 'rooms').map((row) => row.method)
    const missing = roomMethods.filter((method) => !simulatedImplements(method))
    expect(missing).toEqual([])
  })
})