// SSH local forwards used when the gateway or the vault is on another machine.
// ServerAliveInterval + ServerAliveCountMax drop a tunnel that goes silent (sleep, dead host)
// instead of holding the local port forever.

function tunnelHasExited(tunnel) {
  return !tunnel || tunnel.exitCode !== null || tunnel.signalCode !== null
}

function sshForwardArgs(port, host) {
  return [
    '-N', '-L', `${port}:127.0.0.1:${port}`,
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '--',
    host,
  ]
}

/**
 * Stop one tunnel: SIGTERM, then SIGKILL after `termMs` if it is still running.
 * Resolves on exit, or shortly after SIGKILL if the process never reports one,
 * so quitting the app cannot wait forever.
 */
function stopTunnel(tunnel, { termMs = 2000, schedule = setTimeout, cancel = clearTimeout } = {}) {
  if (tunnelHasExited(tunnel)) return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    let killTimer
    let hardTimer
    const finish = () => {
      if (settled) return
      settled = true
      if (killTimer) cancel(killTimer)
      if (hardTimer) cancel(hardTimer)
      resolve()
    }
    killTimer = schedule(() => {
      try { tunnel.kill('SIGKILL') } catch { /* already gone */ }
      hardTimer = schedule(finish, 500)
    }, termMs)
    if (typeof tunnel.once === 'function') tunnel.once('exit', finish)
    try {
      tunnel.kill('SIGTERM')
    } catch {
      finish()
    }
  })
}

module.exports = { sshForwardArgs, stopTunnel, tunnelHasExited }
