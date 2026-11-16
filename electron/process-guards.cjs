// Last-resort log for the Electron main process. The embedded server runs here, so an error
// without a listener would quit the app. These handlers log the message and stack only: an error
// object can carry a request body or a secret on another property, and those must not be printed.

function errorText(error) {
  if (typeof error === 'string') return error
  if (error instanceof Error) {
    if (typeof error.stack === 'string' && error.stack) return error.stack
    if (typeof error.message === 'string' && error.message) return error.message
  }
  return 'unknown error'
}

function installProcessGuards(target = process, write = (line) => { console.error(line) }) {
  const report = (kind, error) => {
    try {
      write(`[hermes-bot] ${kind}: ${errorText(error)}`)
    } catch {
      // Logging must not become a second uncaught error.
    }
  }
  target.on('uncaughtException', (error) => { report('uncaughtException', error) })
  target.on('unhandledRejection', (reason) => { report('unhandledRejection', reason) })
}

module.exports = { installProcessGuards, errorText }
