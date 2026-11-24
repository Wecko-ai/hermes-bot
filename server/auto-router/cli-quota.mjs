#!/usr/bin/env node
/**
 * Record one completed provider call, or one rate-limit error, into provider-quota.json.
 * Prints one JSON object. Never prints the prompt. A missing signal is `{ recorded: false }`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function expandHome(value) {
  if (typeof value !== 'string' || !value) return value
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function defaultPaths() {
  const settings = readJson(expandHome('~/.hermes/hermesbot-settings.json')) || {}
  const appConfig = readJson(expandHome('~/Library/Application Support/HermesBot/config.json')) || {}
  const tablePath = expandHome(
    settings.autoRouter?.tablePath
    || appConfig.autoRouter?.tablePath
    || '~/.hermes/hermesbot-auto-router.table.json',
  )
  const logDir = expandHome(
    appConfig.autoRouter?.logDir
    || settings.autoRouter?.logDir
    || '~/Library/Application Support/HermesBot/auto-router',
  )
  return { tablePath, logDir }
}

function quotaModuleCandidates() {
  const home = os.homedir()
  return [
    process.env.HERMESBOT_QUOTA_MODULE,
    path.join(HERE, 'provider-quota.mjs'),
    path.resolve(HERE, '../../../server/auto-router/provider-quota.mjs'),
    path.join(home, 'worktrees/hermes-bot-quota-models/server/auto-router/provider-quota.mjs'),
    path.join(home, 'worktrees/hermes-bot-quota-gw/server/auto-router/provider-quota.mjs'),
  ].filter((file) => typeof file === 'string' && file.length > 0)
}

let quotaModule = null

export async function loadQuotaModule() {
  if (quotaModule) return quotaModule
  let best = null
  let bestContract = -1
  for (const file of quotaModuleCandidates()) {
    if (!fs.existsSync(file)) continue
    try {
      const mod = await import(pathToFileURL(file).href)
      const contract = Number(mod.QUOTA_GATEWAY_CONTRACT) || 0
      if (contract > bestContract) {
        best = mod
        bestContract = contract
      } else if (!best) best = mod
    } catch {
      /* try the next checkout */
    }
  }
  if (!best) throw new Error('provider-quota.mjs not found')
  quotaModule = best
  return best
}

function argValue(args, name) {
  const index = args.indexOf(name)
  if (index < 0 || index + 1 >= args.length) return ''
  return args[index + 1]
}

function hasFlag(args, name) {
  return args.includes(name)
}

function fullIdOf(provider, model) {
  const name = String(provider || '').trim()
  const id = String(model || '').trim()
  if (!name) return id
  if (!id || id === name || id.startsWith(`${name}/`)) return id || name
  return `${name}/${id}`
}

function parseWhen(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  if (/^\d+(\.\d+)?$/.test(text)) {
    const n = Number(text)
    const ms = n >= 1e12 ? n : n * 1000
    const date = new Date(ms)
    return Number.isFinite(date.getTime()) ? date.toISOString() : ''
  }
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : ''
}

function nonNeg(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.min(Math.floor(n), 1e12)
}

function loadTable(tablePath) {
  if (!tablePath || !fs.existsSync(tablePath)) return {}
  const table = readJson(tablePath)
  return table && typeof table === 'object' ? table : {}
}

function emit(stdout, payload, code) {
  stdout.write(`${JSON.stringify(payload)}\n`)
  return code
}

/**
 * @param {string[]} argv
 * @param {{ stdout?: { write(s: string): void }, stderr?: { write(s: string): void } }} [io]
 */
export async function run(argv, io = {}) {
  const stdout = io.stdout || process.stdout
  const stderr = io.stderr || process.stderr
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    stdout.write('Usage: cli-quota.mjs use|error --provider ID --model ID [--dir DIR] [--table FILE] [--tokens-in N] [--tokens-out N] [--started-at TIME] [--pick] [--status N] [--message TEXT] [--retry-after S] [--reset TIME]\n')
    return 0
  }
  const command = argv[0] === 'use' || argv[0] === 'error' ? argv[0] : ''
  const provider = argValue(argv, '--provider').trim()
  const model = argValue(argv, '--model').trim()
  if (!command || !provider || !model) {
    return emit(stdout, { ok: false, error: 'usage' }, 2)
  }
  const paths = defaultPaths()
  const logDir = argValue(argv, '--dir') || paths.logDir
  const tablePath = argValue(argv, '--table') || paths.tablePath
  if (!logDir || !path.isAbsolute(logDir)) {
    return emit(stdout, { ok: false, error: 'bad_dir' }, 2)
  }
  let storeMod
  try {
    storeMod = await loadQuotaModule()
  } catch (error) {
    stderr.write(`quota module: ${error && error.name ? error.name : 'error'}\n`)
    return emit(stdout, { ok: false, error: 'module' }, 2)
  }
  const { createProviderQuotaStore } = storeMod
  const store = createProviderQuotaStore(logDir)
  const table = loadTable(tablePath)
  const fullId = fullIdOf(provider, model)
  try {
    if (command === 'use') {
      const recorded = await store.recordUse({
        table,
        provider,
        model,
        fullId,
        mode: 'auto',
        label: '',
        reason: 'gateway',
        tokensIn: nonNeg(argValue(argv, '--tokens-in')) ?? 0,
        tokensOut: nonNeg(argValue(argv, '--tokens-out')),
        startedAt: parseWhen(argValue(argv, '--started-at')),
        pick: hasFlag(argv, '--pick'),
        fallbackFrom: null,
      })
      return emit(stdout, { ok: true, recorded: recorded === true, skipped: recorded === 'reserved' ? 'reserved' : null }, 0)
    }
    const headers = {}
    const retryAfter = argValue(argv, '--retry-after').trim()
    const reset = argValue(argv, '--reset').trim()
    if (retryAfter) headers['retry-after'] = retryAfter
    if (reset) headers['x-ratelimit-reset'] = reset
    const recorded = await store.noteErrors({
      table,
      errors: [{
        provider,
        model: fullId,
        status: argValue(argv, '--status'),
        message: argValue(argv, '--message'),
        headers,
      }],
    })
    return emit(stdout, { ok: true, recorded: recorded === true }, 0)
  } catch (error) {
    stderr.write(`quota write: ${error && error.name ? error.name : 'error'}\n`)
    return emit(stdout, { ok: false, error: 'write' }, 2)
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  const code = await run(process.argv.slice(2))
  process.exit(code)
}
