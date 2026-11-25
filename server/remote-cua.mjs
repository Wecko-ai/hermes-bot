// HermesBot side of the remote-cua take-over lease (hermes-plugins/remote-cua, from hermes-bot-kit, MIT).
// Take over / hand back for a Mac a bot drives over SSH (a remote Mac). The lease file and its lock belong to
// the plugin: writes go through the plugin's own lease.py, installed in the profile, run by python3.
// Nothing here touches the remote Mac.
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const HOST = /^[A-Za-z0-9_][A-Za-z0-9._:-]{0,252}$/
const USER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/
/** One HermesBot per Mac: a stable viewer id, so a hand back still works after the app restarts. */
export const REMOTE_CUA_VIEWER = 'hermesbot'

export const profileHome = (root, profile) => (profile === 'default' ? root : path.join(root, 'profiles', profile))

const scalar = (text) => {
  let value = String(text).split(' #')[0].trim()
  if (value.length >= 2 && value[0] === value.at(-1) && `'"`.includes(value[0])) value = value.slice(1, -1)
  return value
}

/** `computer_use` and `remote_cua`, flat `key: value` lines only (no YAML library in the app). */
export function readRemoteCuaConfig(home) {
  let lines
  try { lines = readFileSync(path.join(home, 'config.yaml'), 'utf8').split(/\r?\n/) } catch { return null }
  const blocks = {}
  let current = null
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    if (!/^\s/.test(line)) {
      const key = line.split(':')[0].trim()
      current = (key === 'computer_use' || key === 'remote_cua') && line.trimEnd().endsWith(':') ? key : null
      if (current) blocks[current] = {}
      continue
    }
    if (current && /^ {2}[^ ]/.test(line) && line.includes(':')) {
      const at = line.indexOf(':')
      blocks[current][line.slice(0, at).trim()] = scalar(line.slice(at + 1))
    }
  }
  const selected = blocks.computer_use?.backend === 'remote-cua'
  const raw = blocks.remote_cua
  if (!raw) return { configured: false, machine: null, problem: 'no_remote_cua_block' }
  const machine = { host: raw.host || '', user: raw.user || '', os: (raw.os || 'macos').toLowerCase() }
  if (!HOST.test(machine.host) || !USER.test(machine.user) || machine.os !== 'macos') return { configured: false, machine: null, problem: 'invalid_remote_cua_block' }
  return { configured: selected, machine, problem: selected ? '' : 'backend_not_remote_cua' }
}

// Runs in `python3 -I`: loads the plugin's lease.py by path and prints one JSON line.
const DRIVER = `
import importlib.util, json, sys
plugin, home, action, viewer, force, epoch = sys.argv[1:7]
spec = importlib.util.spec_from_file_location("hermesbot_remote_cua_lease", plugin + "/lease.py")
lease = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = lease
spec.loader.exec_module(lease)
from pathlib import Path
home = Path(home)
try:
    if action == "take":
        out = {"ok": True, "lease": lease.take(viewer, home).to_dict()}
    elif action == "release":
        out = {"ok": True, "lease": lease.release(viewer or None, home, force=force == "1", expect_epoch=int(epoch) if epoch else None).to_dict()}
    else:
        out = {"ok": True, "lease": lease.read(home).to_dict()}
except lease.LeaseConflict as exc:
    out = {"ok": False, "error": exc.code, "lease": exc.lease.to_dict()}
except ValueError as exc:
    out = {"ok": False, "error": getattr(exc, "code", "bad_request")}
print(json.dumps(out))
`

function runDriver(python, args) {
  return new Promise((resolve, reject) => {
    execFile(python, ['-I', '-c', DRIVER, ...args], { timeout: 8_000, env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME || '' } }, (error, stdout) => {
      if (error) return reject(Object.assign(new Error('remote_cua_unavailable'), { status: 502 }))
      try { resolve(JSON.parse(String(stdout).trim().split('\n').pop())) } catch { reject(Object.assign(new Error('remote_cua_unavailable'), { status: 502 })) }
    })
  })
}

/** `{ configured, installed, machine, lease }` for a bot, and take / release through the plugin. */
export function createRemoteCua({ hermesRoot, python = process.env.HERMESBOT_PYTHON || '/usr/bin/python3' }) {
  const target = (profile) => {
    if (!PROFILE.test(String(profile || ''))) throw Object.assign(new Error('invalid_request'), { status: 400 })
    const home = profileHome(hermesRoot, profile)
    const plugin = path.join(home, 'plugins', 'remote-cua')
    return { home, plugin, installed: existsSync(path.join(plugin, 'lease.py')) }
  }
  async function status(profile) {
    const { home, plugin, installed } = target(profile)
    const config = readRemoteCuaConfig(home) || { configured: false, machine: null, problem: 'no_profile' }
    const answer = installed ? await runDriver(python, [plugin, home, 'get', '', '0', '']) : { ok: true, lease: { holder: 'agent', viewer: null, since: 0, epoch: 0 } }
    return { ...config, configured: config.configured && installed, installed, lease: answer.lease, mine: answer.lease?.viewer === REMOTE_CUA_VIEWER }
  }
  async function setControl(profile, active, { force = false, epoch = null } = {}) {
    const { home, plugin, installed } = target(profile)
    const config = readRemoteCuaConfig(home)
    if (!installed || !config?.configured) throw Object.assign(new Error('not_configured'), { status: 409 })
    const answer = await runDriver(python, [plugin, home, active ? 'take' : 'release', REMOTE_CUA_VIEWER, force ? '1' : '0', Number.isInteger(epoch) ? String(epoch) : ''])
    return { ...config, installed, ok: answer.ok, error: answer.error || '', lease: answer.lease, mine: answer.lease?.viewer === REMOTE_CUA_VIEWER }
  }
  return { status, setControl }
}
