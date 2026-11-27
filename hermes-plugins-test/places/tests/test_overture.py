"""Overture fallback adapters: JSONL (dependency-free) and GeoParquet (duckdb optional)."""

from __future__ import annotations

import unittest
from pathlib import Path

from places.tests.helpers import FIXTURES, NOW

from places.core import overture

ORIGIN = (48.8570, 2.3519)


class JsonlAdapterTests(unittest.TestCase):
    def setUp(self):
        self.adapter = overture.JsonlAdapter(FIXTURES / "overture_cafes.jsonl")

    def test_available(self):
        ok, reason = self.adapter.available()
        self.assertTrue(ok, reason)

    def test_missing_file_unavailable(self):
        ok, reason = overture.JsonlAdapter(Path("/nonexistent/places.jsonl")).available()
        self.assertFalse(ok)

    def test_search_filters_category_distance_and_garbage(self):
        pois, fetched_at = self.adapter.search("cafe", ORIGIN[0], ORIGIN[1], 300, NOW)
        self.assertEqual(fetched_at, NOW)
        names = {p["name"] for p in pois}
        # wrong category, broken coords, far away and non-JSON lines are all skipped
        self.assertEqual(names, {"Cafe du Coin", "Overture Only Roastery"})
        coin = next(p for p in pois if p["name"] == "Cafe du Coin")
        self.assertEqual(coin["source_id"], "overture:08f2fab2c1cafes001")
        self.assertEqual(coin["features"], {"wifi": True, "power_outlets": None})

    def test_never_emits_reviews_or_ratings(self):
        pois, _ = self.adapter.search("cafe", ORIGIN[0], ORIGIN[1], 300, NOW)
        for poi in pois:
            self.assertNotIn("rating", poi)
            self.assertNotIn("reviews", poi)


class JsonlSourcesTests(unittest.TestCase):
    """Record-level ``sources`` (dataset names) feed the per-place attribution."""

    def setUp(self):
        self.adapter = overture.JsonlAdapter(FIXTURES / "overture_sources.jsonl")

    def _pois(self):
        pois, _ = self.adapter.search("cafe", ORIGIN[0], ORIGIN[1], 300, NOW)
        return {p["source_id"]: p for p in pois}

    def test_sources_preserved(self):
        coin = self._pois()["overture:src-1"]
        self.assertEqual(coin["sources"], ["foursquare", "meta"])

    def test_record_without_sources_is_untouched(self):
        self.assertIsNone(self._pois()["overture:src-2"]["sources"])

    def test_non_list_sources_ignored(self):
        self.assertIsNone(self._pois()["overture:src-5"]["sources"])

    def test_sources_normalized_and_deduped(self):
        messy = self._pois()["overture:src-4"]
        # cleaned (trimmed), case-insensitively deduped, non-strings dropped
        self.assertEqual(messy["sources"], ["foursquare", "meta"])

    def test_sources_capped_per_record(self):
        long_tail = self._pois()["overture:src-3"]
        self.assertEqual(len(long_tail["sources"]), 3)
        self.assertTrue(all(len(s) <= 40 for s in long_tail["sources"]))


class GeoParquetAdapterTests(unittest.TestCase):
    def test_unavailable_without_duckdb_or_file(self):
        adapter = overture.GeoParquetAdapter(Path("/nonexistent/places.parquet"))
        ok, reason = adapter.available()
        self.assertFalse(ok)
        self.assertTrue(reason)

    def test_search_unavailable_raises(self):
        adapter = overture.GeoParquetAdapter(Path("/nonexistent/places.parquet"))
        with self.assertRaises(overture.AdapterUnavailable):
            adapter.search("cafe", ORIGIN[0], ORIGIN[1], 300, NOW)


class AdapterSelectionTests(unittest.TestCase):
    def test_prefers_geoparquet_then_jsonl(self):
        self.assertIsInstance(
            overture.adapter_from_config({"overture_geoparquet": "/tmp/x.parquet",
                                          "overture_jsonl": "/tmp/x.jsonl"}),
            overture.GeoParquetAdapter)
        self.assertIsInstance(
            overture.adapter_from_config({"overture_jsonl": "/tmp/x.jsonl"}),
            overture.JsonlAdapter)
        self.assertIsNone(overture.adapter_from_config({}))


if __name__ == "__main__":
    unittest.main()
