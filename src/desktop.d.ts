interface Window {
  /** Only present in the Electron app, absent in browser mode. */
  hermesBot?: {
    platform: 'electron'
    restartTunnel: () => Promise<void>
  }
}
