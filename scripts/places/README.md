# Places data pipeline

Operator scripts that build the offline Overture Places extract consumed by the
`hermes-places` plugin (`hermes-plugins/places/`). Everything here is local
data work: the plugin itself never downloads Overture data.

## Pipeline

1. `import_overture.py` — download one small, prefiltered GeoParquet extract
   from the Overture Maps release on S3 (category + bounding box).
2. `parquet_to_jsonl.py` — convert that extract (or a raw Overture GeoParquet
   file) to the plugin's JSONL interchange format:
   `{"id", "name", "category", "lat", "lon", "address"?, "confidence"?, "sources"?}`.
   `sources` is the per-record attribution: the dataset names from the
   Overture `sources` struct list (e.g. `["Foursquare", "Overture"]`),
   trimmed, deduplicated case-insensitively, at most 10 entries of 80
   characters each. Records without source data simply omit the field.

Both scripts write to a temporary file first, refuse to replace any existing
output or sidecar metadata, and report a precise record count. Malformed rows
are skipped, never fatal.

## Environment

```bash
python3.13 -m venv /path/to/venv        # the runtime venv used here is python 3.13
/path/to/venv/bin/pip install -r scripts/places/requirements.lock
```

The exact direct pins live in `requirements.lock` (duckdb 2.0.1, trafilatura
2.3.1, pyvalhalla 3.9.3, osmium 4.3.2, SearXNG at commit
`c6ee3e9fd0235004a694e63720efc869bb1e3594`).

## Reproduce the Osaka cafes extract

```bash
VENV=/path/to/places-runtime/venv
DATA=/path/to/places-data

# 1. Download the raw extract (network, ~MBs): 5155 cafes in the Osaka bbox.
"$VENV/bin/python" scripts/places/import_overture.py \
  --output "$DATA/osaka-overture-cafes.parquet" \
  --release 2026-11-18.0 --category cafe \
  --west 135.35 --south 34.50 --east 135.75 --north 34.85

# 2. Normalize to the plugin's JSONL (offline; raw GeoParquet input also works).
"$VENV/bin/python" scripts/places/parquet_to_jsonl.py \
  --input "$DATA/osaka-overture-cafes.parquet" \
  --output "$DATA/osaka-overture-cafes.jsonl"
```

Each run writes a sidecar `<output>.json` with source, count, and license
attribution (Overture Maps Foundation and per-record sources,
CDLA-Permissive-2.0 / Apache-2.0). Outputs are never overwritten: pick a new
file name for a new extract.

The JSONL respects the plugin's caps (`hermes-plugins/places/core/overture.py`):
at most 500 000 lines, 64 KB per line, 200 MB total.

## Tests

Offline only — DuckDB is faked, no network, no real data files touched:

```bash
/path/to/venv/bin/python -m unittest discover -s scripts/places -p 'test_*.py' -v
```
