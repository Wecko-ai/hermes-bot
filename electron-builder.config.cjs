const fs = require('node:fs')
const path = require('node:path')
const { signApp, signModeFrom } = require('./scripts/mac-sign.cjs')
const { afterPackDarwin } = require('./electron/fuses.cjs')

// A private build may ship its own settings and bot animations in private/ (ignored by git, see server/config.cjs).
const privateConfig = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'private', 'hermesbot.config.json'), 'utf8'))
  } catch {
    return {}
  }
})()

// Icon Composer icon first: since macOS 26 a plain .icns is shrunk into a grey plate in the Dock.
const privateIconComposer = path.join(__dirname, 'private', 'assets', 'HermesBot.icon')
const privateIcon = path.join(__dirname, 'private', 'assets', 'icon.icns')
const macIcon = fs.existsSync(privateIconComposer)
  ? privateIconComposer
  : fs.existsSync(path.join(__dirname, 'assets', 'HermesBot.icon'))
    ? 'assets/HermesBot.icon'
    : fs.existsSync(privateIcon)
      ? privateIcon
      : 'assets/icon.icns'

const appId = typeof privateConfig.appId === 'string' && privateConfig.appId ? privateConfig.appId : 'app.hermesbot.desktop'

// Optional code signature, off by default (scripts/mac-sign.cjs): "adhoc", "adhoc-bundle" or a signing identity.
// The environment variable comes first, so a build can try a mode, or switch it off, without the private file.
const macSign = signModeFrom(process.env.HERMESBOT_MAC_SIGN ?? privateConfig.macSign)

// The dictation helper, built by scripts/build-dictation.cjs (run by `npm run pack`). Absent (no Swift toolchain):
// the app is packaged without it and the page uses its own fallback.
const dictationHelper = path.join(__dirname, 'native', 'dictation', '.build', 'hermesbot-dictation')

module.exports = {
  appId,
  productName: 'HermesBot',
  asar: true,
  electronDist: 'node_modules/electron/dist',
  directories: { output: 'release' },
  files: [
    'dist/**/*',
    'server/**/*',
    'electron/**/*',
    'package.json',
    'private/hermesbot.config.json',
    'private/animations/*.webp',
    // Local backups and tests never go in the app.
    '!**/*.bak-claude-*',
    '!server/**/*.test.mjs',
    '!electron/**/*.test.mjs',
  ],
  // Default pack: macOS Apple silicon dir output (`release/mac-arm64/`).
  // Intel macOS: add `target: [{ target: 'dir', arch: ['x64'] }]` (or both archs in one array).
  // Linux x64: set `linux: { target: ['AppImage', 'deb'], category: 'Utility', icon: 'assets/icon.png' }`
  // and run electron-builder with `--linux` (unsigned unless you configure signing).
  mac: {
    category: 'public.app-category.productivity',
    icon: macIcon,
    target: [{ target: 'dir', arch: ['arm64'] }],
    identity: null,
    // Left off on purpose. A hardened runtime is not used on this install.
    hardenedRuntime: false,
    // A process outside the asar: the helper runs as a child of the app, which macOS names in its prompts.
    extraResources: fs.existsSync(dictationHelper) ? [{ from: dictationHelper, to: 'hermesbot-dictation' }] : [],
    // What macOS shows when it asks for the microphone and for speech recognition (dictation).
    extendInfo: {
      NSMicrophoneUsageDescription: 'HermesBot listens to the microphone only while you dictate a message.',
      NSSpeechRecognitionUsageDescription: 'HermesBot turns what you dictate into text with the speech recognition of macOS.',
    },
  },
  npmRebuild: false,
  // electron-builder's own signing stays off (identity null): it would seal the whole bundle, with a code hash
  // that changes at every build. The hook flips three Electron fuses, then signs in the chosen mode.
  // `electronFuses` stays unset: the packager would otherwise flip the wire again after that signature.
  afterPack: (context) => afterPackDarwin({
    platform: context.electronPlatformName,
    appPath: path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`),
    macSign,
    signApp: (appPath, mode) => signApp(appPath, mode, appId),
  }),
}
