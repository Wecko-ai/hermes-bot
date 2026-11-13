// Optional code signature of the packaged macOS app (option `macSign`, see electron-builder.config.cjs).
//
// macOS only accepts notifications (UNUserNotificationCenter) from an app whose code signature carries the app's
// bundle identifier. The stock runtime's linker signature says "Electron", so an unsigned package is refused.
//
// Modes:
// - "adhoc": only the main executable is signed, ad hoc, with the bundle identifier and a designated requirement
//   on that identifier. Info.plist and resources stay unsealed, as in an unsigned package, so the code hash only
//   depends on the runtime's executable: it stays the same from one build to the next. That matters because the
//   keychain ties the app's safeStorage key to its code; a hash that changes at every build means a keychain
//   prompt at every update.
// - "adhoc-bundle": the whole bundle is signed ad hoc, inside out, with the same identifier requirement. The
//   resources are sealed, so the code hash changes with every build.
// - any other string: a code-signing identity of the keychain (codesign's `--sign` argument), whole bundle.
//
// Usage: node scripts/mac-sign.cjs <App.app> <adhoc|adhoc-bundle|identity> [bundle id]
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const MACH_O_MAGICS = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca'])
const OFF = new Set(['', 'false', 'off', 'none', 'no', '0'])

/** The signing mode of a `macSign` setting, or null to leave the package unsigned (the default). */
function signModeFrom(value) {
  if (value === undefined || value === null || value === false) return null
  if (typeof value !== 'string') throw new Error('macSign must be "adhoc", "adhoc-bundle" or the name of a signing identity')
  const mode = value.trim()
  return OFF.has(mode.toLowerCase()) ? null : mode
}

function isMachO(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const head = Buffer.alloc(4)
    return fs.readSync(fd, head, 0, 4, 0) === 4 && MACH_O_MAGICS.has(head.toString('hex'))
  } finally {
    fs.closeSync(fd)
  }
}

const isBundle = (name) => name.endsWith('.app') || name.endsWith('.framework')

/** A bundle's own executable is signed with the bundle, not on its own. */
function isBundleExecutable(file) {
  const parent = path.dirname(file)
  if (path.basename(parent) === 'MacOS' && path.basename(path.dirname(parent)) === 'Contents') return true
  // Name.framework/Versions/A/Name
  const versions = path.dirname(parent)
  return path.basename(versions) === 'Versions' && path.basename(path.dirname(versions)) === `${path.basename(file)}.framework`
}

/** Nested code of an app, deepest first: loose binaries, then bundles. The app itself is not listed. */
function nestedCode(appPath) {
  const binaries = []
  const bundles = []
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      // Symbolic links (framework layout, Current) point at code signed through its real path.
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        walk(full)
        if (isBundle(entry.name)) bundles.push(full)
      } else if (entry.isFile() && !isBundleExecutable(full) && isMachO(full)) {
        binaries.push(full)
      }
    }
  }
  walk(path.join(appPath, 'Contents'))
  const depth = (file) => file.split(path.sep).length
  const deepestFirst = (a, b) => depth(b) - depth(a)
  return [...binaries.sort(deepestFirst), ...bundles.sort(deepestFirst)]
}

function plistValue(appPath, key) {
  return execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim()
}

function codesign(args) {
  execFileSync('/usr/bin/codesign', args, { stdio: ['ignore', 'inherit', 'inherit'] })
}

// No hardened runtime and no timestamp: neither applies to a local, non-notarized build.
const signArgs = (identity) => ['--force', '--sign', identity, '--timestamp=none']
const identifierRequirement = (appId) => `designated => identifier "${appId}"`

/**
 * The main executable alone. codesign seals the whole bundle when given a bundle's executable in place,
 * so the copy is signed outside the bundle, then moved back under a new inode (the kernel caches the
 * signature of a file it has seen; rewriting one in place can get the new binary killed).
 */
function signExecutable(appPath, appId) {
  const executable = path.join(appPath, 'Contents', 'MacOS', plistValue(appPath, 'CFBundleExecutable'))
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-sign-'))
  try {
    const copy = path.join(directory, path.basename(executable))
    fs.copyFileSync(executable, copy)
    codesign([...signArgs('-'), '--identifier', appId, '--requirements', `=${identifierRequirement(appId)}`, copy])
    codesign(['--verify', '--strict', copy])
    const staged = `${executable}.signed`
    fs.copyFileSync(copy, staged)
    fs.chmodSync(staged, fs.statSync(executable).mode)
    fs.renameSync(staged, executable)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

/** Signs `appPath` according to `mode` (see the top of this file). */
function signApp(appPath, mode, appId = plistValue(appPath, 'CFBundleIdentifier')) {
  if (!mode) throw new Error('mac-sign: no signing mode')
  if (!/^[A-Za-z0-9.-]+$/.test(appId)) throw new Error(`mac-sign: unexpected bundle id ${JSON.stringify(appId)}`)
  if (mode === 'adhoc') return signExecutable(appPath, appId)
  const identity = mode === 'adhoc-bundle' ? '-' : mode
  for (const code of nestedCode(appPath)) codesign([...signArgs(identity), code])
  // With a certificate, codesign derives a requirement on it; ad hoc, its default would be the code hash.
  const requirement = identity === '-' ? ['--requirements', `=${identifierRequirement(appId)}`] : []
  codesign([...signArgs(identity), ...requirement, appPath])
  codesign(['--verify', '--deep', '--strict', appPath])
}

module.exports = { signApp, signModeFrom, nestedCode, isBundleExecutable }

if (require.main === module) {
  const [appPath, mode, appId] = process.argv.slice(2)
  if (!appPath || !signModeFrom(mode)) {
    console.error('Usage: node scripts/mac-sign.cjs <App.app> <adhoc|adhoc-bundle|identity> [bundle id]')
    process.exit(2)
  }
  signApp(path.resolve(appPath), signModeFrom(mode), appId || undefined)
  console.log(`signed (${signModeFrom(mode)})`)
}
