const fs = require('node:fs')
const path = require('node:path')

// A private build may ship its own settings and bot animations in private/ (ignored by git, see server/config.cjs).
const privateConfig = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'private', 'hermesbot.config.json'), 'utf8'))
  } catch {
    return {}
  }
})()

const privateIcon = path.join(__dirname, 'private', 'assets', 'icon.icns')

module.exports = {
  appId: typeof privateConfig.appId === 'string' && privateConfig.appId ? privateConfig.appId : 'app.hermesbot.desktop',
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
  ],
  mac: {
    category: 'public.app-category.productivity',
    icon: fs.existsSync(privateIcon) ? privateIcon : 'assets/icon.icns',
    target: [{ target: 'dir', arch: ['arm64'] }],
    identity: null,
    hardenedRuntime: false,
  },
  npmRebuild: false,
}
