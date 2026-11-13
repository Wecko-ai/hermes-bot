// Builds the dictation helper (native/dictation) with the Swift compiler of Xcode or of the Command Line Tools.
// The binary goes to native/dictation/.build/ (ignored by git); electron-builder.config.cjs ships it when it is
// there. Without a Swift toolchain, or elsewhere than macOS, this says so and the app is packaged without
// dictation: the page then falls back to its own path.
const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const DIRECTORY = path.join(__dirname, '..', 'native', 'dictation')
// The helper and its pure parts, compiled together as one module (the Swift package splits them for its tests).
const SOURCES = [
  path.join(DIRECTORY, 'Sources', 'hermesbot-dictation', 'main.swift'),
  path.join(DIRECTORY, 'Sources', 'DictationCore', 'TranscriptMerger.swift'),
  path.join(DIRECTORY, 'Sources', 'DictationCore', 'SessionGate.swift'),
]
const INFO_PLIST = path.join(DIRECTORY, 'Info.plist')
const OUTPUT = path.join(DIRECTORY, '.build', 'hermesbot-dictation')

function swiftCompiler() {
  try {
    return execFileSync('/usr/bin/xcrun', ['--find', 'swiftc'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}

function build() {
  if (process.platform !== 'darwin') {
    console.log('dictation helper: macOS only, skipped (the app is packaged without dictation)')
    return
  }
  if (!swiftCompiler()) {
    fs.rmSync(OUTPUT, { force: true })
    console.log('dictation helper: no Swift toolchain (xcode-select --install), the app is packaged without dictation')
    return
  }
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true })
  const staged = `${OUTPUT}.tmp`
  const args = ['-O', '-swift-version', '5', '-target', 'arm64-apple-macos13', '-o', staged, ...SOURCES]
  // The usage strings inside the helper itself, for the Speech framework's own check of its process.
  if (fs.existsSync(INFO_PLIST)) args.push('-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', INFO_PLIST)
  // Through xcrun: it gives the compiler the macOS SDK, which a bare swiftc path does not find on its own.
  const result = spawnSync('/usr/bin/xcrun', ['--sdk', 'macosx', 'swiftc', ...args], { stdio: 'inherit' })
  if (result.status !== 0) {
    fs.rmSync(staged, { force: true })
    console.error('dictation helper: the Swift build failed')
    process.exit(1)
  }
  fs.renameSync(staged, OUTPUT)
  console.log(`dictation helper: built ${path.relative(process.cwd(), OUTPUT)}`)
}

build()
