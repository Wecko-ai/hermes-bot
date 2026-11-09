module.exports = {
  appId: 'app.hermesbot.desktop',
  productName: 'HermesBot',
  asar: true,
  electronDist: 'node_modules/electron/dist',
  directories: { output: 'release' },
  files: [
    'dist/**/*',
    'server/**/*',
    'electron/**/*',
    'package.json',
  ],
  mac: {
    category: 'public.app-category.productivity',
    icon: 'assets/icon.icns',
    target: [{ target: 'dir', arch: ['arm64'] }],
    identity: null,
    hardenedRuntime: false,
  },
  npmRebuild: false,
}
