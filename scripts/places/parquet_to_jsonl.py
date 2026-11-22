#!/usr/bin/env python3
"""Convert a local Overture Parquet extract to the plugin's JSONL format.

Accepts either the normalized extract produced by ``import_overture.py``
(``category``/``latitude``/``longitude`` columns) or a raw Overture
GeoParquet file (``basic_category`` + ``geometry``, ``names`` struct) and
always emits the plugin's documented interchange shape::

    {"id", "name", "category", "lat", "lon", "address"?, "confidence"?, "sources"?}

``sources`` carries the per-record dataset names from the Overture
``sources`` struct list (e.g. ``["Foursquare", "Overture"]``) so the
"per-record sources" attribution stays visible after normalization.

Output never replaces an existing file, and the JSONL is bounded by the
caps enforced by ``hermes-plugins/places/core/overture.py``: at most
500 000 lines, at most 64 KB per line, at most 200 MB total. Rows that do
not normalize (bad name, missing id, non-finite or out-of-range
coordinates, oversized line) are skipped so one malformed record can
never break a full import.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import uuid

import duckdb

# Mirror of hermes-plugins/places/core/overture.py (JsonlAdapter caps).
MAX_LINES = 500_000
MAX_LINE_BYTES = 64_000
MAX_JSONL_BYTES = 200_000_000

# Per-record source attribution bounds.
MAX_SOURCES = 10
SOURCE_NAME_MAX = 80


def address_text(value: object) -> str:
    if not isinstance(value, list) or not value or not isinstance(value[0], dict):
        return ""
    address = value[0]
    parts = []
    for key in ("freeform", "locality", "region", "country"):
        part = address.get(key)
        if isinstance(part, str) and part.strip() and part.strip() not in parts:
            parts.append(part.strip())
    return ", ".join(parts)[:300]


def source_names(value: object) -> list[str]:
    """Normalized, bounded dataset names from the Overture ``sources`` struct list.

    Whitespace is collapsed and trimmed, empty or non-string dataset names are
    dropped, duplicates (case-insensitive) keep their first occurrence, and the
    list is capped at ``MAX_SOURCES`` entries of at most ``SOURCE_NAME_MAX``
    characters.
    """
    if not isinstance(value, list):
        return []
    names: list[str] = []
    seen: set[str] = set()
    for entry in value:
        if not isinstance(entry, dict):
            continue
        dataset = entry.get("dataset")
        if not isinstance(dataset, str):
            continue
        name = " ".join(dataset.split())[:SOURCE_NAME_MAX].strip()
        if not name:
            continue
        key = name.casefold()
        if key in seen:
            continue
        seen.add(key)
        names.append(name)
        if len(names) >= MAX_SOURCES:
            break
    return names


def normalized_row(row: tuple) -> dict | None:
    identifier, name, category, latitude, longitude, addresses, confidence, sources = row
    if not isinstance(name, str) or not name.strip() or not isinstance(category, str):
        return None
    if not category.strip():
        return None
    if identifier is None or isinstance(identifier, bool) or not str(identifier).strip():
        return None
    # bool is a subclass of int; reject it explicitly for coordinates.
    if isinstance(latitude, bool) or isinstance(longitude, bool):
        return None
    if not isinstance(latitude, (int, float)) or not isinstance(longitude, (int, float)):
        return None
    if not (math.isfinite(latitude) and math.isfinite(longitude)):
        return None
    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        return None
    record = {
        "id": str(identifier),
        "name": name.strip()[:200],
        "category": category.strip().lower(),
        "lat": latitude,
        "lon": longitude,
    }
    address = address_text(addresses)
    if address:
        record["address"] = address
    if isinstance(confidence, (int, float)) and not isinstance(confidence, bool) and math.isfinite(confidence):
        record["confidence"] = confidence
    attribution = source_names(sources)
    if attribution:
        record["sources"] = attribution
    return record


def select_expressions(columns: set[str]) -> tuple[str, bool]:
    """Pick the SQL select list and whether the spatial extension is needed.

    Normalized extracts expose plain ``category``/``latitude``/``longitude``
    columns; raw Overture GeoParquet exposes ``basic_category`` and a WKB
    ``geometry`` instead, with the place name nested in ``names.primary``.
    """
    if {"category", "latitude", "longitude"} <= columns:
        return "category, latitude, longitude", False
    if {"basic_category", "geometry"} <= columns:
        return (
            "basic_category AS category, "
            "ST_Y(geometry) AS latitude, ST_X(geometry) AS longitude",
            True,
        )
    raise SystemExit("Parquet needs category/latitude/longitude or basic_category/geometry columns")


def name_expression(columns: set[str]) -> str:
    """Raw Overture keeps the display name in a struct, not a flat column."""
    return "name" if "name" in columns else "names.primary AS name"


def write_metadata(metadata_path: Path, metadata: dict) -> None:
    """Create the sidecar metadata file, never replacing an existing one."""
    payload = json.dumps(metadata, ensure_ascii=False, indent=2) + "\n"
    fd = os.open(metadata_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(payload)


def convert(connection, source: Path, output: Path) -> int:
    """Convert ``source`` Parquet to ``output`` JSONL; return the record count."""
    metadata_path = output.with_suffix(output.suffix + ".json")
    if output.exists():
        raise SystemExit(f"Refusing to replace existing JSONL: {output}")
    if metadata_path.exists():
        raise SystemExit(f"Refusing to replace existing metadata: {metadata_path}")
    if not output.parent.is_dir():
        raise SystemExit(f"Output directory does not exist: {output.parent}")
    columns = {
        row[0] for row in connection.execute(
            "DESCRIBE SELECT * FROM read_parquet(?)", [str(source)]
        ).fetchall()
    }
    coordinates, needs_spatial = select_expressions(columns)
    if needs_spatial:
        connection.execute("INSTALL spatial; LOAD spatial;")
    total = connection.execute("SELECT count(*) FROM read_parquet(?)", [str(source)]).fetchone()[0]
    limited = min(int(total), MAX_LINES)
    source_column = ", sources" if "sources" in columns else ", NULL AS sources"
    rows = connection.execute(
        f"SELECT id, {name_expression(columns)}, {coordinates}, addresses, confidence{source_column} "
        "FROM read_parquet(?) LIMIT ?",
        [str(source), limited],
    ).fetchall()
    temporary = output.with_name(f".{output.name}.{uuid.uuid4().hex}.tmp")
    count = 0
    written = 0
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        for row in rows:
            record = normalized_row(row)
            if record is None:
                continue
            try:
                line = json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
            except (TypeError, ValueError, OverflowError):
                continue
            encoded = line.encode("utf-8")
            if len(encoded) > MAX_LINE_BYTES:
                continue
            if written + len(encoded) > MAX_JSONL_BYTES:
                raise SystemExit(f"JSONL would exceed {MAX_JSONL_BYTES} bytes; partial output preserved at {temporary}")
            handle.write(line)
            written += len(encoded)
            count += 1
    if count == 0:
        raise SystemExit(f"No usable records; partial JSONL preserved at {temporary}")
    temporary.rename(output)
    write_metadata(metadata_path, {
        "input": str(source),
        "count": count,
        "skipped": int(total) - count,
        "truncated": int(total) > MAX_LINES,
        "line_cap": MAX_LINES,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "attribution": "Overture Maps Foundation and per-record sources (CDLA-Permissive-2.0 / Apache-2.0)",
    })
    return count


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    source = args.input.expanduser().resolve(strict=True)
    output = args.output.expanduser().resolve(strict=False)
    if source.suffix.lower() != ".parquet" or output.suffix.lower() not in {".jsonl", ".ndjson"}:
        raise SystemExit("Expected a .parquet input and .jsonl/.ndjson output")
    connection = duckdb.connect(database=":memory:")
    try:
        count = convert(connection, source, output)
    finally:
        connection.close()
    print(json.dumps({"output": str(output), "count": count}))


if __name__ == "__main__":
    main()
