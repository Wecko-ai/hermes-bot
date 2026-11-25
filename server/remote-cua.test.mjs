import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRemoteCua, readRemoteCuaConfig } from './remote-cua.mjs'

const LEASE_PY = path.resolve(import.meta.dirname, '../hermes-plugins/remote-cua/lease.py')
let root = ''
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = '' })

function profile(name, config, { installed = true } = {}) {
  const home = path.join(root, 'profiles', name)
  mkdirSync(home, { recursive: true })
  writeFileSync(path.join(home, 'config.yaml'), config)
  if (installed) {
    mkdirSync(path.join(home, 'plugins', 'remote-cua'), { recursive: true })
    copyFileSync(LEASE_PY, path.join(home, 'plugins', 'remote-cua', 'lease.py'))
  }
  return home
}

const STUDIO = 'model: x\ncomputer_use:\n  backend: remote-cua  # studio\nremote_cua:\n  host: pro\n  user: "alex"\n  os: macos\nother:\n  host: nope\n'

describe('remote-cua lease (HermesBot side)', () => {
  it('reads only the remote_cua block and needs the backend selected', () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'rcua-'))
    expect(readRemoteCuaConfig(profile('a', STUDIO))).toEqual({ configured: true, machine: { host: 'pro', user: 'alex', os: 'macos' }, problem: '' })
    expect(readRemoteCuaConfig(profile('b', 'remote_cua:\n  host: pro\n  user: alex\n')).configured).toBe(false)
    expect(readRemoteCuaConfig(profile('c', 'remote_cua:\n  host: -oProxyCommand=x\n  user: alex\ncomputer_use:\n  backend: remote-cua\n')).problem).toBe('invalid_remote_cua_block')
    expect(readRemoteCuaConfig(profile('d', 'model: x\n')).configured).toBe(false)
  })

  it('takes and hands back through the plugin lease, refuses an unconfigured bot', async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'rcua-'))
    profile('studio-bot', STUDIO)
    profile('plain', 'model: x\n')
    const remote = createRemoteCua({ hermesRoot: root })
    let state = await remote.status('studio-bot')
    expect(state).toMatchObject({ configured: true, installed: true, lease: { holder: 'agent', epoch: 0 }, mine: false })
    state = await remote.setControl('studio-bot', true)
    expect(state).toMatchObject({ ok: true, lease: { holder: 'human', viewer: 'hermesbot', epoch: 1 }, mine: true })
    expect((await remote.status('studio-bot')).lease.holder).toBe('human')
    state = await remote.setControl('studio-bot', false)
    expect(state).toMatchObject({ ok: true, lease: { holder: 'agent', epoch: 2 } })
    await expect(remote.setControl('plain', true)).rejects.toMatchObject({ message: 'not_configured' })
    await expect(remote.status('../x')).rejects.toMatchObject({ message: 'invalid_request' })
    expect((await remote.status('plain')).configured).toBe(false)
  })

  it('a forced hand back needs the epoch it saw', async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'rcua-'))
    const home = profile('studio-bot', STUDIO)
    mkdirSync(path.join(home, 'remote-cua'), { recursive: true })
    writeFileSync(path.join(home, 'remote-cua', 'lease.json'), JSON.stringify({ holder: 'human', viewer: 'pane-old', since: 1, epoch: 4 }))
    const remote = createRemoteCua({ hermesRoot: root })
    expect(await remote.setControl('studio-bot', false)).toMatchObject({ ok: false, error: 'not_holder' })
    expect(await remote.setControl('studio-bot', false, { force: true, epoch: 3 })).toMatchObject({ ok: false, error: 'stale_force' })
    expect(await remote.setControl('studio-bot', false, { force: true, epoch: 4 })).toMatchObject({ ok: true, lease: { holder: 'agent', epoch: 5 } })
  })
})
