---
name: hermesbot-health-checkup
description: "Run a read-only health checkup of a HermesBot install: the desktop app's local server, the Hermes gateway, optional companions (browser vault, SearXNG, local models), logs of the last 24-48 h, the auto-router and zero-spend logs, and repository hygiene. Use when the user asks to check HermesBot's health, diagnose errors, inspect logs or audit the running stack. Never changes anything by itself."
version: 1.0.0
metadata:
  hermes:
    tags: [HermesBot, Diagnostics, Health, Logs]
---

# HermesBot health checkup

A structured, **read-only** diagnostic of a HermesBot stack. It ends with a report of what works, what needs attention and the next steps, each one marked when it would change state.

Adapt the ports and paths below to your own install: they are the defaults of HermesBot and Hermes Agent. Skip any section whose component you do not run.

## Safety rules

- **Read-only.** During a checkup, do not restart services, edit Hermes profiles or configs, delete or move files, or start paid model turns. Propose fixes instead and let the user approve each one.
- **No secrets.** Never print `.env` files, cookies, tokens, keychain items or encrypted app data. For the app data folder, list metadata only (`ls -lh`).
- **No raw payloads.** Summarize logs as counts and normalized patterns (timestamps, error class, component). Do not paste prompts, message bodies or URLs with query strings.

## Procedure

Run the checks in parallel where you can.

### 1. Disk, app bundle and builds

```bash
df -h /
ls -lh /Applications/HermesBot.app/Contents/Resources/app.asar
```

- Warn when `/` has less than 20 GiB free or is over 85 % full. Check any external build or backup volume the same way, and make sure it is mounted read-write (read the `mount` output; a `-w` test can lie inside a sandbox).
- If you build the app yourself, compare the installed `app.asar` (size and date) with your latest build.

### 2. Services and health endpoints

```bash
launchctl list | grep -iE 'hermes|searxng|vault'      # macOS; use systemctl --user on Linux
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(4330|9120|8080|11434)\b'
```

Probe loopback endpoints with a 3 s timeout each:

| Endpoint | Expected |
| --- | --- |
| `http://127.0.0.1:4330/api/health` (HermesBot local server, `PORT`) | `200 {"ok":true,"service":"hermes-bot"}` |
| `http://127.0.0.1:9120/api/status` (Hermes gateway Webapp, `HERMES_ORIGIN`) | `200`, gateway running |
| `$SEARXNG_URL/healthz` (if you use `hermes-plugins/web-resilient` with SearXNG) | `200 OK` |
| `http://127.0.0.1:11434/api/ps` (Ollama, optional local chat) | `200` |

Flag every launch agent or service with a non-zero last exit status, starting with the Hermes gateway.

### 3. Logs of the last 24-48 h

| Component | Where | What to look for |
| --- | --- | --- |
| Hermes gateway | `~/.hermes/logs/` (`errors.log`, `gateway.error.log`) | Top normalized `WARNING` / `ERROR` / `CRITICAL` patterns and their counts |
| Gateway restarts | `~/.hermes/logs/` and your launchd/systemd log | Restart frequency; crash loops versus planned restarts |
| HermesBot app | the app's launchd/stdout log | Crashes, unhandled rejections |
| Browser vault (optional) | `~/Library/Application Support/HermesBot/browser-vault-audit.jsonl` | Counts by `(action, result)`; repeated `login_fields_not_found`, `origin_not_found`, `cdp_unavailable` |
| Auto-router | `~/Library/Application Support/HermesBot/auto-router/routing-*.jsonl` | Success rate, fallback count, turns slower than 30 s, model distribution |
| Zero-spend (optional) | `~/.hermes/zero-spend-blocks.jsonl` | Top `(profile, provider, model, reason)`; tell intended blocks from misconfigured profiles |
| SearXNG (optional) | its service log | Missing `contact_url` or `limiter.toml`, engines failing on every query |

Also look at which web backend each profile uses: a profile that relies on one free backend with no fallback is fragile (the `resilient` provider of `hermes-plugins/web-resilient` fails over between SearXNG and `ddgs`).

### 4. Memory and other plugins

If a profile uses a memory or extraction plugin backed by a model, check that the configured provider still exists (an expired subscription fails silently), and look for timeouts or token-limit errors in that plugin's log.

### 5. Repository hygiene (when HermesBot runs from a clone)

```bash
git status -sb
git worktree list | wc -l
gh run list -L 5        # latest CI runs, if you use GitHub Actions
```

- Uncommitted changes and piles of backup files (`*.bak*`).
- Stale worktrees (flag more than 10).
- Red CI runs.

## Known benign signals

Cross-check these before reporting a defect:

1. **`SystemExit: 75` (`EX_TEMPFAIL`)** is how the Hermes gateway exits on a planned graceful restart, so that launchd or systemd starts it again. It is a crash only when no restart was requested.
2. **`Plugin 'basic' tried to register dashboard-auth provider 'basic'`** is an upstream Hermes warning, logged once per profile load. No fix is needed.
3. **`read pool at capacity`** in Hermes state means a bounded read pool is saturated during bursts; Hermes falls back to the writer connection. Worth a look only when it happens dozens of times a day.
4. **Budget-cap blocks** in `zero-spend-blocks.jsonl` mean the guard did its job; they are not errors.

## Report

Answer in four parts:

1. **Overall status**: Healthy, Degraded or Critical, with a 2-3 line summary.
2. **What works**: concrete checks with numbers (router success rate, CI runs, disk headroom, endpoints up).
3. **What needs work**: ordered High / Medium / Low, each with its evidence (counts, time range, file).
4. **Suggested fixes**: one command or change per issue, each marked "changes state, needs your OK" when it does.
