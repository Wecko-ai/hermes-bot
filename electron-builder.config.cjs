const fs = require('node:fs')
const path = require('node:path')
const { signApp, signModeFrom } = require('./scripts/mac-sign.cjs')

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
  mac: {
    category: 'public.app-category.productivity',
    icon: macIcon,
    target: [{ target: 'dir', arch: ['arm64'] }],
    identity: null,
    hardenedRuntime: false,
  },
  npmRebuild: false,
  // electron-builder's own signing stays off (identity null): it would seal the whole bundle, with a code hash
  // that changes at every build. The hook signs after packing, in the chosen mode.
  afterPack: async (context) => {
    if (!macSign || context.electronPlatformName !== 'darwin') return
    signApp(path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`), macSign, appId)
  },
}
