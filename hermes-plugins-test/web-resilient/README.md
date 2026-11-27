# web-resilient

A free, keyless Hermes web provider plugin with **runtime failover** between a
configured local **SearXNG** instance and the free **ddgs** package, plus
**bounded local HTTP extraction** (no browser, no paid provider, no API key).

## What it provides

A single `WebSearchProvider` named `resilient`, registered through
`PluginContext.register_web_search_provider()`. It implements both capabilities:

- `search` — SearXNG first (when `SEARXNG_URL` is set), then DDGS. The choice is
  made **per call**: a backend that fails (HTTP error, timeout, malformed
  response, circuit open) is skipped and the next one is tried. A backend that
  answers *successfully with zero results* does not count as a failure — the
  other backend is still consulted, and if both are empty the result is a
  successful empty list (empty ≠ error). When every backend fails, the provider
  fails honestly: `{"success": false, "error": "All free search backends failed (...)"}`.
- `extract` — fetches pages locally over HTTP with hard caps (time, bytes,
  redirects, output chars) and parses them with **Trafilatura when installed**,
  falling back to a safe stdlib `html.parser` text extractor. Only `http`/`https`;
  private, loopback, link-local (incl. cloud metadata) and other non-public
  targets are refused **after DNS resolution**, on the initial URL *and every
  redirect hop*.

Response shapes are the exact legacy contract (the tool wrapper does not
translate):

```
search:  {"success": True, "data": {"web": [{"title", "url", "description", "position"}, ...]}}
extract: [{"url", "title", "content", "raw_content", "metadata"}, ...]   # per-URL "error" entries on failure
failure: {"success": False, "error": str}
```

## Safety properties

- **DDGS hard process timeout.** `ddgs`/`primp` can block in native code while
  holding the GIL, so every DDGS search runs in a disposable child process
  (`_ddgs_worker.py`) that the parent terminates, then kills, after a hard
  wall-clock cap (default 30 s, `RESILIENT_…` env below). The shared agent loop
  can never freeze on a hung search.
- **Circuit breakers.** Each backend gets its own breaker (3 consecutive
  failures → 60 s cooldown) so a dead SearXNG stops adding its timeout to every
  search while recovering automatically once it is back.
- **Brief success cache.** Successful (and all-empty-but-successful) search
  responses are memoized in-process for a short TTL, keyed by
  `(hermes home, active profile, query, limit)`. Failures are never cached.
  Nothing is written to disk.
- **No sensitive logs.** Queries are never logged raw — only
  `len=<n> id=<sha256-8>` correlation tags. No secrets are read or logged.
- **SSRF.** Extraction has no loopback exception: it never fetches the local
  SearXNG (or anything else internal). The *single* narrow exception is the
  explicitly configured `SEARXNG_URL` origin for search requests only — and only
  when the URL's hostname matches the configured origin (a literal
  `http://127.0.0.1/...` typed into a page is still refused).
- **DNS-rebinding safe (pinned resolution).** Each URL — and every redirect
  hop — is resolved exactly once and the TCP connection is pinned to one of the
  *validated* addresses; the hostname is never re-resolved between the check
  and the connect. TLS keeps the original hostname as SNI and certificate
  identity, so public HTTPS sites work unchanged while a swapped DNS answer
  cannot redirect the fetch to an internal address.
- **Platform TLS trust.** HTTPS uses the Hermes platform trust store when
  available (`agent.ssl_verify.platform_ssl_context` — macOS Security.framework,
  Windows CryptoAPI, Linux store, with `SSL_CERT_FILE` honoured on top) and the
  stdlib default otherwise. Verification is never disabled.

## Configuration

Via environment / `hermes config set` (read through the config-aware env layer):

| Variable | Default | Meaning |
| --- | --- | --- |
| `SEARXNG_URL` | _(unset)_ | Local SearXNG base URL, e.g. `http://localhost:8080`. Optional — DDGS alone works. |
| `RESILIENT_CACHE_TTL_SECONDS` | `300` | Successful-search memo TTL. |
| `RESILIENT_CACHE_MAX_ENTRIES` | `128` | Memo size bound (oldest evicted). |
| `RESILIENT_CIRCUIT_COOLDOWN_SECONDS` | `60` | Circuit-breaker cooldown. |
| `RESILIENT_EXTRACT_TIMEOUT_SECONDS` | `20` | Per-page fetch timeout. |
| `RESILIENT_EXTRACT_MAX_BYTES` | `2000000` | Per-page byte cap. |
| `RESILIENT_EXTRACT_MAX_CHARS` | `50000` | Per-page output cap. |
| `RESILIENT_EXTRACT_MAX_REDIRECTS` | `5` | Redirect cap (each hop re-validated). |

Enable it with `web.search_backend: resilient` / `web.extract_backend: resilient`
(`web.backend: resilient` sets both).

## Notes and non-goals

- **No JavaScript execution.** Pages that need JS to render extract as an honest
  per-URL error (`"page contained no extractable text (possibly
  JavaScript-rendered)"`). A future fallback could hand such pages to the
  existing browser tool (Chrome CDP) for a rendered DOM dump; that path is
  deliberately **not** implemented here — this plugin never drives a browser.
- **No paid provider, no Firecrawl, no keyless ring, no API key.**
- Hostile page/review text is treated as data, never instructions.
- `is_available()` is a cheap local check (env var / package importable); it
  performs no network I/O, per the provider contract.
