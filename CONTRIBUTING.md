# Contributing to HermesBot

Thanks for your interest. Bug reports, fixes and new features are welcome.

## Getting started

```bash
npm ci
npm run dev        # http://127.0.0.1:4330
```

Open `http://127.0.0.1:4330/?demo=1` to work on the interface without Hermes. To use real bots, run a Hermes Agent gateway on `127.0.0.1:9120` (see the README).

## Before you open a pull request

```bash
npm run check:ci   # same gates as GitHub Actions: check, Vite build, and E2E (needs Google Chrome)
```

Or step by step: `npm run check`, `npx vite build`, and `npm run test:e2e` against the simulated gateway.

Set `E2E_PORT`, `E2E_GATEWAY_PORT`, `E2E_CDP_PORT`, and `E2E_VAULT_PORT` if the default test ports are already in use.

- Keep changes focused, and describe how you verified them.
- Tests never call a real model: the end-to-end suite uses a fake gateway (`tests/e2e.mjs`). Please keep it that way.
- Never commit secrets, `.env` files, session files, or screenshots with personal data.
- Settings specific to one installation belong in `config.json` (see `.env.example` and `server/config.cjs`), not in the code.

## Rules the code relies on

- The local server only listens on `127.0.0.1` and checks `Host` and `Origin`.
- Hermes tokens and cookies stay on the server side. The window only gets an opaque session id.
- Bot replies may contain hostile content: no remote image ever loads, bot files only go through `/api/media` and `/api/document`, and HTML documents stay in a sandboxed iframe with no network. Do not relax these policies.
- A message sent to a bot may cost money. Nothing in the app sends one without a user action.

## Reporting a bug

Include the steps to reproduce, what you expected, your macOS and Hermes versions, and relevant logs with secrets removed. For a security issue, see `SECURITY.md` instead.
