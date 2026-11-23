# HermesBot architecture

HermesBot is a desktop client for [Hermes Agent](https://github.com/NousResearch/hermes-agent). It does not run models itself: bots, tools, memory and scheduled jobs stay in Hermes. This document is for contributors and packagers (English, public).

## Process layout

```text
┌─────────────────────────────────────────────────────────────┐
│  Electron shell (optional)                                  │
│    main process: tunnel, dictation, speech, notifications   │
│    renderer: React UI (Vite bundle)                         │
└───────────────────────────┬─────────────────────────────────┘
                            │ http://127.0.0.1:4330 (same origin)
┌───────────────────────────▼─────────────────────────────────┐
│  Node server (server/)                                      │
│    REST: auth, config, media, documents, local-chat, vault  │
│    proxies selected Hermes HTTP APIs with session checks      │
└─────┬───────────────────┬──────────────────┬─────────────────┘
      │                   │                  │
      │ WebSocket         │ optional SSH     │ separate process
      ▼                   ▼                  ▼
 Hermes gateway      remote host         Browser vault
 127.0.0.1:9120       port 9120           127.0.0.1:4331
 JSON-RPC             forwarded           credentials + autofill
 hermes-gateway-v1
```

### Local server (`127.0.0.1:4330`)

- Serves the built UI and implements `/api/*` routes (see `server/index.mjs`).
- Enforces local session cookies for mutating routes; never exposes gateway tokens to the page except through controlled relay.
- `server/config.cjs` merges environment variables, user config, and an optional private install file (not in the public tree).

### Hermes gateway (`127.0.0.1:9120` by default)

- JSON-RPC 2.0 over WebSocket (`src/lib/hermes.ts`).
- Drives chat (`session.*`, `prompt.submit`), roster (`profiles.*`), optional rooms (`groups.*`), subagents, and server-initiated requests (`approval`, `vault.*`, …).
- HermesBot ignores unknown server requests so another client's answer is not stolen.

### Browser vault (`127.0.0.1:4331`)

- Optional companion service (`server/browser-vault/`) for shared-browser login flows initiated by bots.
- Credentials stay in the OS keychain for the login macOS session; not available over SSH by design.

## Gateway contract

The UI methods are catalogued in `src/lib/gateway-contract.ts`. Vitest checks that every **required** method is implemented by the simulated gateway in `tests/e2e.mjs`.

| Hermes version | Notes for HermesBot |
|----------------|---------------------|
| **0.23.0** | Individual bots, steer, subagent/process APIs, profile management |
| **0.23.2** | Hosted rooms (`groups.*`), `replayable_disband`, shared settings file via gateway FS API |

Older gateways: the app degrades gracefully (`-32601` → feature hidden). Rooms need 0.23.2+ with the room driver enabled.

## Hermes plugins in this repo

Public plugins under `hermes-plugins/` extend Hermes without patching core:

| Plugin | Purpose |
|--------|---------|
| `places` | Nearby places and pedestrian routing (no API keys) |
| `web-resilient` | Resilient web search and extraction |
| `zero-spend` | Blocks paid routes when HermesBot zero-spend mode is on |

Copy into a profile's plugins directory; **never** auto-install into `~/.hermes` from CI or this app.

Request-level blocking on fallbacks and auxiliary calls requires Hermes builds that honor `action: block` on `pre_api_request` / `pre_auxiliary_call` (see plugin READMEs).

## Builds and targets

`electron-builder.config.cjs` defaults to **macOS Apple silicon** (`target: dir`, `arch: arm64`). Packaging is unsigned by default; macOS notifications need ad hoc signing (`scripts/mac-sign.cjs`).

Additional targets (documented, not enabled in the default config):

```javascript
// Intel macOS
mac: { target: [{ target: 'dir', arch: ['x64'] }] }

// Linux x64
linux: { target: ['AppImage', 'deb'], category: 'Utility' }
```

Run heavy builds through your own job runner. Quick UI validation: `npm run build` (Vite only). Full desktop pack: `npm run pack`.

Use `scripts/install.sh` for an idempotent dev setup (`--dry-run` prints steps without executing).

## Example profiles

See `examples/profiles/` for three neutral bots (assistant, researcher, writer) and install instructions.

## Security summary

- Binds to loopback only unless you explicitly configure a remote gateway origin and SSH tunnel.
- No telemetry channel; MIT license.
- See `SECURITY.md` for reporting and threat model.