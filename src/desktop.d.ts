interface Window {
  /** Présent seulement dans l'app Electron, absent en mode navigateur. */
  hermesBot?: {
    platform: 'electron'
    restartTunnel: () => Promise<void>
  }
}
