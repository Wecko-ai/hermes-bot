"""Persistent last-good cache, scoped to the active Hermes home and profile.

The cache only ever stores *successful* provider payloads (raw POI records),
never failures, and never the caller's precise coordinates: the cache key uses
a ~110 m grid cell, so the origin position is not recoverable from the file.
Cache writes are atomic (tmp file + ``os.replace``) and mode 0600.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Optional

from . import config, sanitize

CACHE_SCHEMA = 1


def cache_dir(home: Path) -> Path:
    return Path(home) / "cache" / "places"


def cache_file(home: Path, profile: str) -> Path:
    slug = sanitize.normalize_name(profile or "default")[:40] or "default"
    return cache_dir(home) / f"{slug}.json"


def entry_key(category: str, lat: float, lon: float, radius_m: float) -> str:
    """Grid-rounded key: the exact origin is deliberately not stored."""
    grid_lat = round(float(lat), 3)
    grid_lon = round(float(lon), 3)
    raw = f"{category}|{grid_lat:.3f}|{grid_lon:.3f}|{int(radius_m)}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


class LastGoodCache:
    def __init__(self, home: Path, profile: str):
        self.path = cache_file(home, profile)

    # -- io ------------------------------------------------------------------
    def _load(self) -> dict:
        try:
            raw = self.path.read_bytes()
        except OSError:
            return {"schema": CACHE_SCHEMA, "entries": {}}
        if len(raw) > config.CACHE_MAX_BYTES:
            return {"schema": CACHE_SCHEMA, "entries": {}}
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return {"schema": CACHE_SCHEMA, "entries": {}}
        if not isinstance(data, dict) or not isinstance(data.get("entries"), dict):
            return {"schema": CACHE_SCHEMA, "entries": {}}
        return data

    def _save(self, data: dict) -> Optional[str]:
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        if len(payload) > config.CACHE_MAX_BYTES:
            return "cache file would exceed size cap; entry not persisted"
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=str(self.path.parent), prefix=".places-", suffix=".tmp")
            try:
                with os.fdopen(fd, "wb") as fh:
                    fh.write(payload)
                os.chmod(tmp, config.CACHE_FILE_MODE)
                os.replace(tmp, self.path)
            except BaseException:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
        except OSError as exc:
            return f"cache write failed: {type(exc).__name__}"
        return None

    # -- api -------------------------------------------------------------------
    def store(self, category: str, lat: float, lon: float, radius_m: float,
              pois: list[dict], fetched_at: Optional[str] = None) -> Optional[str]:
        """Persist a successful provider payload.  Returns a warning or None."""
        if not isinstance(pois, list):
            return "refusing to cache malformed payload"
        data = self._load()
        data["entries"][entry_key(category, lat, lon, radius_m)] = {
            "fetched_at": fetched_at or sanitize.iso_now(),
            "pois": pois,
        }
        return self._save(data)

    def fetch(self, category: str, lat: float, lon: float, radius_m: float):
        """Return ``(pois, fetched_at, stale)`` or ``None``.

        ``stale`` is True when the entry is older than :data:`config.CACHE_TTL_S`;
        stale entries are only meant to be served when every live provider failed.
        """
        data = self._load()
        entry = data["entries"].get(entry_key(category, lat, lon, radius_m))
        if not isinstance(entry, dict):
            return None
        pois = entry.get("pois")
        fetched_at = entry.get("fetched_at")
        if not isinstance(pois, list) or not isinstance(fetched_at, str):
            return None
        age = sanitize.iso_age_seconds(fetched_at)
        stale = age is None or age > config.CACHE_TTL_S
        return pois, fetched_at, stale

    def describe(self) -> dict:
        """Doctor-facing metadata (no payload contents, no keys tied to locations)."""
        data = self._load()
        entries = data["entries"]
        ages = []
        for entry in entries.values():
            if isinstance(entry, dict) and isinstance(entry.get("fetched_at"), str):
                age = sanitize.iso_age_seconds(entry["fetched_at"])
                if age is not None:
                    ages.append(age)
        return {
            "path": str(self.path),
            "entries": len(entries),
            "oldest_age_seconds": int(max(ages)) if ages else None,
            "newest_age_seconds": int(min(ages)) if ages else None,
        }
