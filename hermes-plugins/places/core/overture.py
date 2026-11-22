"""Overture Maps fallback adapters (optional, offline data only).

Two adapters, both reading *local* prefiltered extracts — the plugin never
downloads Overture data itself:

- :class:`JsonlAdapter` (dependency-free): one place feature per line, in the
  shape ``{"id", "name", "category", "lat", "lon", "address"?, "wifi"?}``
  plus an optional ``"sources"`` list of dataset names (e.g.
  ``["foursquare", "meta"]``) that is carried into the per-place attribution.
  This is the documented interchange format for an offline extract (see
  README "Offline fixtures / Overture fallback").
- :class:`GeoParquetAdapter` (only when the optional ``duckdb`` package is
  importable): runs a bbox/category SQL filter over a local GeoParquet file
  whose schema exposes plain ``latitude``/``longitude`` (or ``lat``/``lon``)
  columns.  Files that only carry a WKB geometry column are reported as
  unusable without the DuckDB ``spatial`` extension, not silently mishandled.

Overture has no reviews: this adapter never emits rating/review fields.

Record-level ``sources`` (dataset names such as ``foursquare`` or ``meta``)
are preserved so the engine can build a verifiable per-place attribution
(``source.name`` like ``Overture Maps (Foursquare, Meta)``).  Records without
``sources`` are unchanged: the place simply keeps the plain Overture name.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Optional

from . import config, geo, sanitize

MAX_JSONL_BYTES = 200_000_000
MAX_JSONL_LINES = 500_000
MAX_LINE_BYTES = 64_000
MAX_SOURCES_PER_RECORD = 3   # keeps source.name inside the contract's 80-char cap
MAX_SOURCE_NAME_CHARS = 40


class AdapterUnavailable(Exception):
    """The adapter cannot serve data (missing file/library or unusable schema)."""


def _record_sources(record: dict) -> Optional[list[str]]:
    """Normalized dataset names from a record's ``sources`` field.

    Returns None when the record carries no usable sources (missing field,
    wrong type, or only garbage) so old records without ``sources`` behave
    exactly as before.
    """
    raw = record.get("sources")
    if not isinstance(raw, list):
        return None
    cleaned: list[str] = []
    seen: set[str] = set()
    for entry in raw:
        if not isinstance(entry, str):
            continue
        item = sanitize.clean_text(entry, MAX_SOURCE_NAME_CHARS)
        if item and item.lower() not in seen:
            seen.add(item.lower())
            cleaned.append(item)
        if len(cleaned) >= MAX_SOURCES_PER_RECORD:
            break
    return cleaned or None


def _raw_poi(record: dict, category: str) -> Optional[dict]:
    name = sanitize.bounded_str(record.get("name"), 200)
    lat, lon = record.get("lat"), record.get("lon")
    if not name or not geo.valid_lat_lon(lat, lon):
        return None
    wifi = record.get("wifi")
    features = None
    if isinstance(wifi, bool):
        features = {"wifi": wifi, "power_outlets": None}
    return {
        "source_id": f"overture:{sanitize.clean_text(record.get('id'), 80) or 'unknown'}",
        "name": name,
        "lat": float(lat),
        "lon": float(lon),
        "address": sanitize.bounded_str(record.get("address"), 300),
        "category": category,
        "features": features,
        "tags": {},
        "sources": _record_sources(record),
    }


class JsonlAdapter:
    """Dependency-free adapter over a prefiltered local JSONL extract."""

    def __init__(self, path: Path):
        self.path = Path(path)

    def available(self) -> tuple[bool, str]:
        if not self.path.is_file():
            return False, f"jsonl extract not found: {self.path}"
        try:
            if self.path.stat().st_size > MAX_JSONL_BYTES:
                return False, "jsonl extract exceeds size cap"
        except OSError as exc:
            return False, f"jsonl extract unreadable: {type(exc).__name__}"
        return True, "ok"

    def search(self, category: str, lat: float, lon: float, radius_m: float,
               now_iso: str) -> tuple[list[dict], str]:
        ok, reason = self.available()
        if not ok:
            raise AdapterUnavailable(reason)
        spec = config.CATEGORIES.get(category)
        wanted = set(spec["overture"]) if spec else set()
        pois: list[dict] = []
        try:
            with self.path.open("rb") as fh:
                for lineno, raw_line in enumerate(fh):
                    if lineno >= MAX_JSONL_LINES:
                        break
                    if len(raw_line) > MAX_LINE_BYTES:
                        continue
                    try:
                        record = json.loads(raw_line.decode("utf-8"))
                    except (UnicodeDecodeError, ValueError):
                        continue
                    if not isinstance(record, dict):
                        continue
                    if str(record.get("category", "")).strip().lower() not in wanted:
                        continue
                    if not geo.valid_lat_lon(record.get("lat"), record.get("lon")):
                        continue
                    if geo.haversine_m(lat, lon, float(record["lat"]), float(record["lon"])) > radius_m:
                        continue
                    poi = _raw_poi(record, category)
                    if poi is not None:
                        pois.append(poi)
        except OSError as exc:
            raise AdapterUnavailable(f"jsonl read failed: {type(exc).__name__}") from None
        return pois, now_iso


class GeoParquetAdapter:
    """Optional DuckDB-backed adapter over a local Overture GeoParquet extract."""

    def __init__(self, path: Path):
        self.path = Path(path)

    def _duckdb(self):
        try:
            import duckdb  # type: ignore
        except ImportError as exc:
            raise AdapterUnavailable("duckdb package not installed") from exc
        return duckdb

    def available(self) -> tuple[bool, str]:
        try:
            duckdb = self._duckdb()
        except AdapterUnavailable as exc:
            return False, str(exc)
        if not self.path.is_file():
            return False, f"geoparquet extract not found: {self.path}"
        try:
            con = duckdb.connect(database=":memory:")
            try:
                cols = {row[0] for row in con.execute(
                    f"DESCRIBE SELECT * FROM parquet_scan('{self.path}')").fetchall()}
            finally:
                con.close()
        except Exception as exc:  # duckdb raises its own Error hierarchy
            return False, f"geoparquet unreadable: {type(exc).__name__}"
        if not ({"latitude", "longitude"} <= cols or {"lat", "lon"} <= cols):
            return False, ("geoparquet schema lacks plain latitude/longitude columns "
                           "(WKB-only geometry needs the duckdb spatial extension; "
                           "prefilter to JSONL instead)")
        return True, "ok"

    def search(self, category: str, lat: float, lon: float, radius_m: float,
               now_iso: str) -> tuple[list[dict], str]:
        ok, reason = self.available()
        if not ok:
            raise AdapterUnavailable(reason)
        spec = config.CATEGORIES.get(category)
        if spec is None:
            return [], now_iso
        duckdb = self._duckdb()
        # Cheap prefilter: bbox + category substring match, refined by haversine here.
        lat_lo, lat_hi = lat - radius_m / 111_320, lat + radius_m / 111_320
        cos_lat = max(0.01, abs(math.cos(math.radians(lat))))
        lon_delta = radius_m / (111_320 * cos_lat)
        lon_lo, lon_hi = max(-180.0, lon - lon_delta), min(180.0, lon + lon_delta)
        categories = ", ".join(f"'{c}'" for c in spec["overture"])
        try:
            con = duckdb.connect(database=":memory:")
            try:
                cols = {row[0]: row[1] for row in con.execute(
                    f"DESCRIBE SELECT * FROM parquet_scan('{self.path}')").fetchall()}
                lat_col = "latitude" if "latitude" in cols else "lat"
                lon_col = "longitude" if "longitude" in cols else "lon"
                rows = con.execute(
                    f"SELECT id, name, category, {lat_col}, {lon_col} "
                    f"FROM parquet_scan('{self.path}') "
                    f"WHERE {lat_col} BETWEEN {lat_lo} AND {lat_hi} "
                    f"AND {lon_col} BETWEEN {lon_lo} AND {lon_hi} "
                    f"AND lower(category) IN ({categories}) LIMIT 200"
                ).fetchall()
            finally:
                con.close()
        except Exception as exc:
            raise AdapterUnavailable(f"geoparquet query failed: {type(exc).__name__}") from None
        pois = []
        for row in rows:
            record = {"id": row[0], "name": row[1], "category": row[2], "lat": row[3], "lon": row[4]}
            if not geo.valid_lat_lon(record["lat"], record["lon"]):
                continue
            if geo.haversine_m(lat, lon, float(record["lat"]), float(record["lon"])) > radius_m:
                continue
            poi = _raw_poi(record, category)
            if poi is not None:
                pois.append(poi)
        return pois, now_iso


def adapter_from_config(settings: dict) -> Optional[object]:
    """Pick an adapter from validated operator settings (see tools.py)."""
    jsonl = settings.get("overture_jsonl")
    parquet = settings.get("overture_geoparquet")
    if parquet:
        return GeoParquetAdapter(Path(parquet))
    if jsonl:
        return JsonlAdapter(Path(jsonl))
    return None
