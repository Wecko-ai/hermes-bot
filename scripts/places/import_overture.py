#!/usr/bin/env python3
"""Download one small Overture Places extract without replacing existing data."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import uuid

import duckdb

RELEASE = re.compile(r"^\d{4}-\d{2}-\d{2}\.\d+$")
CATEGORY = re.compile(r"^[a-z0-9_]{1,80}$")
SOURCE = "s3://overturemaps-us-west-2/release"


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--release", required=True)
    parser.add_argument("--category", default="cafe")
    for name in ("west", "south", "east", "north"):
        parser.add_argument(f"--{name}", type=float, required=True)
    return parser.parse_args()


def main() -> None:
    args = arguments()
    if not RELEASE.fullmatch(args.release):
        raise SystemExit("Invalid Overture release")
    if not CATEGORY.fullmatch(args.category):
        raise SystemExit("Invalid category")
    if not (-180 <= args.west < args.east <= 180 and -90 <= args.south < args.north <= 90):
        raise SystemExit("Invalid bounding box")
    output = args.output.expanduser().resolve(strict=False)
    metadata_path = output.with_suffix(output.suffix + ".json")
    if output.exists():
        raise SystemExit(f"Refusing to replace existing extract: {output}")
    if metadata_path.exists():
        raise SystemExit(f"Refusing to replace existing metadata: {metadata_path}")
    if not output.parent.is_dir():
        raise SystemExit(f"Output directory does not exist: {output.parent}")
    temporary = output.with_name(f".{output.name}.{uuid.uuid4().hex}.tmp")
    source = f"{SOURCE}/{args.release}/theme=places/type=place/*"
    connection = duckdb.connect()
    connection.execute("INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs;")
    connection.execute("SET allow_asterisks_in_http_paths = true;")
    connection.execute("SET s3_region = 'us-west-2';")
    query = f"""
COPY (
  SELECT id, names.primary AS name, basic_category AS category, taxonomy, confidence,
         ST_Y(geometry) AS latitude, ST_X(geometry) AS longitude,
         geometry, addresses, websites, phones, sources, operating_status
  FROM read_parquet('{source}')
  WHERE basic_category = '{args.category}'
    AND ST_X(geometry) BETWEEN {args.west} AND {args.east}
    AND ST_Y(geometry) BETWEEN {args.south} AND {args.north}
) TO '{str(temporary).replace("'", "''")}' (FORMAT PARQUET)
"""
    connection.execute(query)
    count = connection.execute("SELECT count(*) FROM read_parquet(?)", [str(temporary)]).fetchone()[0]
    if count < 1:
        raise SystemExit(f"No matching places; partial extract preserved at {temporary}")
    temporary.rename(output)
    metadata = {
        "source": source,
        "release": args.release,
        "category": args.category,
        "bbox": [args.west, args.south, args.east, args.north],
        "count": count,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "attribution": "Overture Maps Foundation and the per-record sources",
    }
    # Exclusive create: a stale or foreign metadata file must never be rewritten.
    fd = os.open(metadata_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"output": str(output), "count": count, "release": args.release}))


if __name__ == "__main__":
    main()
