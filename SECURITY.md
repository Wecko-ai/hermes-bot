# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability"). Describe the issue and how to reproduce it; we will reply as soon as we can.

## Threat model in short

- HermesBot runs on your own machine. Its server listens on `127.0.0.1:4330` only and rejects requests whose `Host` or `Origin` is not local.
- It considers that whatever answers on the gateway address (`127.0.0.1:9120` by default) is your Hermes gateway. A local process that took that port would receive your password, but it would already run with your rights.
- Hermes cookies and tickets stay in the server process. In the desktop app, saved sessions and the optional saved password are encrypted with the macOS Keychain (`safeStorage`) and never sent back to the window.
- Bot output is treated as untrusted: no remote resource loads, bot files only go through the local server with a fixed content type, and HTML pages run in a sandboxed iframe without network access.
- Bots run with the rights of the Hermes gateway's user. HermesBot does not sandbox them; use Hermes' own approval settings and terminal backends (for example Docker) for that.
