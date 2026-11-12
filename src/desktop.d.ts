interface Window {
  /** Only present in the Electron app, absent in browser mode. */
  hermesBot?: {
    platform: 'electron'
    restartTunnel: () => Promise<void>
    /** Brings the window to the front (a notification was clicked). */
    focusWindow?: () => Promise<void>
  }
}
