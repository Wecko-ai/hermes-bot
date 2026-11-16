// The standalone server logs a fatal error and keeps listening. Under Electron the main
// process installs its own handlers and quits through app.quit(), so these stay off.

export function shouldInstallProcessGuards(versions = process.versions) {
  return !versions?.electron
}

export function installProcessGuards(target, { onShutdown, onError }) {
  if (!shouldInstallProcessGuards(target.versions)) return false
  target.on('uncaughtException', onError)
  target.on('unhandledRejection', onError)
  target.on('SIGINT', onShutdown)
  target.on('SIGTERM', onShutdown)
  return true
}
