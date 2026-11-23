# Hermes plugin: zero-spend

Blocks paid or unverified model API routes when **HermesBot zero-spend mode** is on (`zeroSpend: true` in `~/.hermes/hermesbot-settings.json`, written from Settings > Models in the app). When the key is missing or the file is unreadable, the plugin stays **off** (no surprise blocks on a fresh install).

## What it allows

- Known **local** providers on loopback only (`ollama`, `omlx`, `lmstudio`, etc.)
- **OpenRouter** models whose id ends with `:free`, or `openrouter/free`
- **Gemini** Flash / Flash-Lite / Hydrogen families on `generativelanguage.googleapis.com` (not Pro-tier names)
- **NVIDIA** developer API on `integrate.api.nvidia.com/v1`
- **Kimi Coding** subscription on `api.kimi.com/coding` only
- **OpenCode Go** on `opencode.ai/zen/go`
- Optional **Cursor** models via a local proxy: set `ZERO_SPEND_CURSOR_PROXY_PORT` (e.g. `10100`) and use `cursor/*` models on that loopback port only

Everything else is refused with `action: block`.

## Hooks

| Hook | Role on stock Hermes 0.23.x |
|------|-------------------------------|
| `pre_llm_call` | Blocks the main model before any inference (always honored) |
| `pre_api_request` | Blocks each provider HTTP attempt when Hermes honors `action: block` on this hook |
| `pre_auxiliary_call` | Same for titling, compression, and other side tasks |

On Hermes builds where `pre_api_request` is still observer-only, only the main turn is fully protected; retries, fallbacks and auxiliaries may still reach a provider until Hermes ships request-level blocking (see Hermes `agent/plugin_request_block.py`). **Enable this plugin together with an up-to-date Hermes** for full coverage.

## Audit log

Refusals append one JSON line per event to `~/.hermes/zero-spend-blocks.jsonl` (provider, model, host, surface, reason — no prompts, secrets or full URLs).

## Install (manual)

Copy or symlink this folder into a profile's `plugins/` directory and enable it in that profile's `config.yaml`. **Do not** commit operator-specific enablement into this repository.

## Tests

```bash
python3 -m unittest discover -s hermes-plugins/zero-spend/tests -p 'test_*.py'
```

Hermes core also ships `tests/agent/test_plugin_request_block.py` when request-level blocking is present.