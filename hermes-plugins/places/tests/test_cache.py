"""Last-good cache: scoping, staleness, atomic writes, no failure caching."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

from places.tests.helpers import NOW

from places.core import cache as cache_mod
from places.core import config

POIS = [{"source_id": "osm:node/1", "name": "Cafe", "lat": 48.85, "lon": 2.35,
         "address": None, "category": "cafe", "features": None, "tags": {}}]
ORIGIN = (48.8570, 2.3519)


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.cache = cache_mod.LastGoodCache(self.home, "default")

    def tearDown(self):
        self.tmp.cleanup()

    def test_scoped_to_profile(self):
        other = cache_mod.LastGoodCache(self.home, "work")
        self.assertNotEqual(self.cache.path, other.path)
        self.assertIn("default", str(self.cache.path))
        self.assertIn("work", str(other.path))
        self.assertEqual(self.cache.path.parent, self.home / "cache" / "places")

    def test_store_and_fetch_fresh(self):
        self.assertIsNone(self.cache.store("cafe", *ORIGIN, 300, POIS, NOW))
        result = self.cache.fetch("cafe", *ORIGIN, 300)
        self.assertIsNotNone(result)
        pois, fetched_at, stale = result
        self.assertEqual(pois, POIS)
        self.assertEqual(fetched_at, NOW)
        self.assertFalse(stale)

    def test_stale_entry_flagged(self):
        old = "2020-01-01T00:00:00Z"
        self.cache.store("cafe", *ORIGIN, 300, POIS, old)
        _, fetched_at, stale = self.cache.fetch("cafe", *ORIGIN, 300)
        self.assertEqual(fetched_at, old)
        self.assertTrue(stale)

    def test_key_is_grid_rounded_not_precise(self):
        k1 = cache_mod.entry_key("cafe", 48.85701, 2.35191, 300)
        k2 = cache_mod.entry_key("cafe", 48.85704, 2.35194, 300)
        k3 = cache_mod.entry_key("cafe", 48.85800, 2.35200, 300)
        self.assertEqual(k1, k2)
        self.assertNotEqual(k1, k3)
        # the raw coordinates are not recoverable from the key
        self.assertNotIn("48.85", k1)

    def test_missing_entry(self):
        self.assertIsNone(self.cache.fetch("cafe", *ORIGIN, 300))

    def test_corrupt_file_treated_as_empty(self):
        self.cache.path.parent.mkdir(parents=True, exist_ok=True)
        self.cache.path.write_text("{ not json", encoding="utf-8")
        self.assertIsNone(self.cache.fetch("cafe", *ORIGIN, 300))

    def test_file_mode_private(self):
        self.cache.store("cafe", *ORIGIN, 300, POIS, NOW)
        mode = os.stat(self.cache.path).st_mode & 0o777
        self.assertEqual(mode, config.CACHE_FILE_MODE)

    def test_oversize_payload_rejected(self):
        huge = [{"source_id": f"osm:node/{i}", "name": "x" * 200, "lat": 48.85,
                 "lon": 2.35, "address": "y" * 300, "category": "cafe",
                 "features": None, "tags": {}} for i in range(20000)]
        warn = self.cache.store("cafe", *ORIGIN, 300, huge, NOW)
        self.assertIsNotNone(warn)

    def test_describe(self):
        self.cache.store("cafe", *ORIGIN, 300, POIS, NOW)
        info = self.cache.describe()
        self.assertEqual(info["entries"], 1)
        self.assertIsNotNone(info["newest_age_seconds"])

    def test_roundtrip_unicode(self):
        pois = [dict(POIS[0], name="珈琲舎")]
        self.cache.store("cafe", *ORIGIN, 300, pois, NOW)
        fetched, _, _ = self.cache.fetch("cafe", *ORIGIN, 300)
        self.assertEqual(fetched[0]["name"], "珈琲舎")
        raw = self.cache.path.read_bytes()
        self.assertIn("珈琲舎".encode("utf-8"), raw)


if __name__ == "__main__":
    unittest.main()
