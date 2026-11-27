# places — Hermes plugin

Find up to 3 real places near a location (cafes, pharmacies, parks, hotels, …).
When a local **Overture Maps** extract is configured it is served first, with
zero provider network calls; otherwise (or to complete it) the plugin queries
**OpenStreetMap** (Overpass). Walking distances come from local Valhalla →
public Valhalla → OSRM → honest straight-line; directions are Google Maps
walking links. Results are returned in the shared `hermes-places` JSON
contract.

No API keys, no paid services, no Hermes core edits. Stdlib only; the optional
DuckDB adapter uses `duckdb` only if it is already installed.

## Install

Copy (or symlink) this directory into the plugins directory of the **active
Hermes home** (the plugin resolves the home at runtime; nothing is hardcoded):

```sh
cp -R places "$HERMES_HOME/plugins/places"   # or: ln -s "$PWD/places" "$HERMES_HOME/plugins/places"
```

then restart the session (or run `hermes` fresh). The plugin registers two
tools in the `places` toolset via the public `ctx.register_tool` API.

## Tools

### `places_nearby`

| argument   | required | notes |
|------------|----------|-------|
| `category` | yes      | one of the schema enum: `cafe`, `restaurant`, `bar`, `bakery`, `pharmacy`, `supermarket`, `convenience_store`, `atm`, `bank`, `hospital`, `clinic`, `park`, `hotel`, `library`, `museum`, `fuel`, `gym` |
| `latitude` | yes      | -90..90 |
| `longitude`| yes      | -180..180 |
| `radius`   | no       | meters, clamped to 50–2000 (default 400) |
| `limit`    | no       | capped at 3 |
| `filters`  | no       | `name_contains` (string), `wheelchair` (boolean) |

Returns a fenced ` ```hermes-places ` block (see below). Zero matches and
total provider failure are distinct plain-text messages, not empty contracts.

### `places_doctor`

Offline diagnostics: endpoint allowlist integrity, Hermes home/cache state,
Overture configuration, adapter availability. `{"probe": true}` adds short
live network probes of one Overpass mirror and of the local (127.0.0.1) and
public Valhalla routing endpoints, using fixed sample points only — the doctor
never takes coordinates. The local probe stays inside Tennoji, Osaka: the
local Valhalla graph only covers that extract, so a point outside it would
fail even against a healthy service (the public probe uses a Paris pair). A
silent local Valhalla is reported as `degraded`
(routing falls back to the public providers), not as a failure.

## Output contract

````text
```hermes-places
{version: 1, generated_at, attributions: [...], warnings: [...], places: [1..3]}
```
````

Each place: `id`, `name`, `latitude`, `longitude`, `category`,
`directions_url` (HTTPS Google Maps, `travelmode=walking`, **destination
only** — the origin is omitted so the phone anchors the route on its own GPS
fix and the caller's position is not embedded in a shareable link), `source`
(name/url/fetched_at), `distance` (`kind: "route"` with `seconds`, or
`kind: "straight_line"` **without** `seconds` — a straight-line estimate is
never dressed up as a walking time). Optional fields (`address`, `features`,
`opening`, `rating`, `reviews`, `photo`) are omitted unless sourced; this
plugin sources address/features from OSM tags only and **never** emits ratings
or reviews (OSM has none and Overture reviews must never be claimed).

## Providers and fallbacks

1. **Local Overture extract, local-first** — when an extract is configured
   (see below) and available, it is scanned *before any network call*. If it
   holds at least `limit` distinct candidates for the request, it is served
   immediately — no Overpass traffic at all (two dead mirrors otherwise cost
   ~24 s per query, the extract costs milliseconds). If it holds fewer, the
   results still count: Overpass is queried and its places merged with the
   local candidates (dedupe drops the overlaps), and when every mirror is
   down the partial extract is served with an honest "results are
   incomplete" warning. A broken extract never breaks the lookup: the live
   path runs unchanged and the failure is only reported when it is actually
   relevant. Two local, offline adapters (the plugin never downloads Overture
   data):
   - *GeoParquet/DuckDB* — used when the optional `duckdb` package is
     installed and a local extract is configured (schema must expose plain
     latitude/longitude columns).
   - *Prefiltered JSONL* — dependency-free; one record per line:
     `{"id", "name", "category", "lat", "lon", "address"?, "wifi"?}`,
     optionally with `"sources": ["foursquare", "meta"]` — the normalized
     dataset names the record was built from. When present they are carried
     into a verifiable per-place attribution: `source.name` becomes
     `Overture Maps (Foursquare, Meta)` (tail entries that would overflow
     the contract's 80-char cap are dropped). Records without `sources`
     keep the plain `Overture Maps` name.
2. **OpenStreetMap / Overpass** — two public mirrors (`overpass-api.de`,
   `overpass.kumi.systems`), 6 s timeout per attempt, one retry per mirror,
   1.5 MB response cap. First choice when no extract is configured.
3. **Last-good cache** — successful Overpass payloads are cached per
   (category, ~110 m grid cell, radius) in `<hermes-home>/cache/places/<profile>.json`
   (mode 0600, atomic writes, 5 MB cap, 7-day staleness). When every live
   provider fails, a cached payload is served with a `warnings` entry that
   says so (and says `stale` when older than the TTL). Failures are never
   cached and the caller's precise origin is never stored or logged.
4. **Routing** — local Valhalla on `127.0.0.1:8002` (pedestrian), then the
   public Valhalla demo endpoint, then OSRM `routed-foot`, then haversine
   (`kind: "straight_line"`, no seconds, warning).

Dedupe is by source id, then normalized name (accent-folded, script-safe) +
75 m proximity; the richer record wins. Ranking is deterministic: straight-line
distance, then normalized name, then source id.

## Configuration (optional)

`<hermes-home>/places/config.json` (max 16 KB):

```json
{"overture_jsonl": "/absolute/path/to/overture_places_extract.jsonl"}
```

or `"overture_geoparquet": "/absolute/path/to/extract.parquet"` ( DuckDB
required; takes precedence). Only absolute paths with the right suffix are
accepted; anything else is reported by `places_doctor`. Endpoints are **not**
configurable — the allowlist is compiled in.

## Security model

- Every request goes through a single gate that refuses any URL not
  byte-identical to a compiled-in HTTPS endpoint (`core/net.py`). No env or
  config can redirect traffic; no credentials are read or transmitted.
- Bounded everything: whole-call time budget (28 s), per-attempt timeouts,
  response-size caps, line/file caps for local extracts, string truncation for
  all provider text. Web/review text is treated as hostile data: cleaned of
  control/format characters, never interpreted.
- No shell, no subprocesses, no remote images. `photo` (if ever sourced) must
  be an existing local absolute path served through the client's own MEDIA
  mechanism — this plugin never fetches photos.
- Opening hours, ratings, reviews stay unknown unless a provider sources them.

## Offline fixtures and Overture import

`tests/fixtures/` contains canned Overpass responses (including empty,
malformed-coordinate and Japanese-name cases) and sample Overture JSONL
extracts (including duplicate rows and per-record `sources`). To build a real
Overture JSONL extract for your city, prefilter the Overture `places` release
with DuckDB (spatial) or `ogr2ogr` down to the categories you care about, then
emit one JSON object per line in the shape above — with a `sources` list of
dataset names per record when you want the per-place attribution. Keep the
extract small (the adapter caps files at 200 MB / 500 k lines) and local —
point `overture_jsonl` at it.

## Tests

Stdlib `unittest`, fully offline (fake opener, no sockets):

```sh
cd hermes-plugins
python3 -m unittest discover -s places/tests -t . -v
```

Covers: mirror failure and failover, retry counts, empty-vs-error distinction,
malformed provider data, timeouts and time budget, stale cache, local-first
Overture serving (zero provider calls when the extract is sufficient,
Overpass merge when it is not, partial extract with honest warning when the
mirrors are down, broken-extract resilience), routing fallback chain,
duplicate handling across sources, Japanese text, missing optional fields,
contract validation, allowlist enforcement and the doctor.
