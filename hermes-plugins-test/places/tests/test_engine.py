"""End-to-end engine behavior with canned providers (no network)."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from places.tests.helpers import (FIXTURES, FakeNet, NOW, overpass_responder, valhalla_ok)

from places.core import cache as cache_mod
from places.core import config, contract, engine, net, overture

ORIGIN = (48.8570, 2.3519)


def params(**kw):
    base = dict(category="cafe", lat=ORIGIN[0], lon=ORIGIN[1], radius_m=300, limit=3)
    base.update(kw)
    return engine.SearchParams(**base)


def happy_net():
    return FakeNet({"overpass_de": overpass_responder("overpass_cafe.json"),
                    "valhalla": valhalla_ok()})


def parse(result: str) -> dict:
    import json

    assert result.startswith("```hermes-places\n"), result[:80]
    return json.loads(result[len("```hermes-places\n"):-len("\n```")])


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.cache = cache_mod.LastGoodCache(self.home, "default")

    def tearDown(self):
        self.tmp.cleanup()

    def test_happy_path_contract(self):
        fake = happy_net()
        doc = engine.search_places(params(), fake.io(), cache=self.cache)
        contract.validate_contract(doc)
        self.assertEqual(doc["version"], 1)
        self.assertEqual(doc["generated_at"], NOW)
        self.assertEqual(len(doc["places"]), 3)
        self.assertIn("OpenStreetMap", " ".join(doc["attributions"]))
        self.assertIn("Valhalla", " ".join(doc["attributions"]))
        self.assertIn("Google Maps", " ".join(doc["attributions"]))
        first = doc["places"][0]
        self.assertEqual(first["id"], "osm:node/1001")  # closest first
        self.assertEqual(first["distance"]["kind"], "route")
        self.assertEqual(first["distance"]["seconds"], 45)
        self.assertTrue(first["directions_url"].startswith("https://www.google.com/maps/dir/"))
        self.assertIn("travelmode=walking", first["directions_url"])
        self.assertIn("destination=48.857020,2.351520", first["directions_url"])
        self.assertNotIn("origin=", first["directions_url"])  # the caller's position is not leaked

    def test_missing_optionals_absent(self):
        fake = FakeNet({"overpass_de": overpass_responder("overpass_cafe.json"),
                        "valhalla": valhalla_ok()})
        doc = engine.search_places(params(), fake.io(), cache=self.cache)
        atlas = next(p for p in doc["places"] if p["id"] == "osm:node/1002")
        self.assertIn("address", atlas)  # street + housenumber tags exist
        self.assertNotIn("features", atlas)  # but no wifi/power tags
        for place in doc["places"]:
            for key in ("opening", "rating", "reviews", "photo"):
                self.assertNotIn(key, place)  # never invented, never claimed

    def test_limit_capped_at_three(self):
        fake = FakeNet({"overpass_de": overpass_responder("overpass_cafe.json"),
                        "valhalla": valhalla_ok()})
        doc = engine.search_places(params(limit=10), fake.io(), cache=self.cache)
        self.assertLessEqual(len(doc["places"]), 3)

    def test_radius_clamped_with_warning(self):
        fake = happy_net()
        doc = engine.search_places(params(radius_m=99999), fake.io(), cache=self.cache)
        self.assertTrue(any("clamped" in w for w in doc["warnings"]))

    def test_empty_provider_result_is_lookup_error_not_provider_error(self):
        fake = FakeNet({"overpass_de": overpass_responder("overpass_empty.json"),
                        "valhalla": valhalla_ok()})
        with self.assertRaises(LookupError) as ctx:
            engine.search_places(params(), fake.io(), cache=self.cache)
        self.assertIn("no places matched", str(ctx.exception))

    def test_total_provider_failure_is_distinct_error(self):
        fake = FakeNet({"overpass_de": net.Timeout("t"), "overpass_kumi": net.Timeout("t")})
        with self.assertRaises(LookupError) as ctx:
            engine.search_places(params(), fake.io(), cache=self.cache)
        self.assertIn("all place providers failed", str(ctx.exception))

    def test_local_first_serves_extract_with_zero_provider_calls(self):
        # a self-sufficient local extract must be served without any Overpass
        # traffic: two dead mirrors cost ~24 s, the extract costs nothing
        fake = FakeNet({"valhalla_local": valhalla_ok()})  # no overpass responders at all
        adapter = overture.JsonlAdapter(FIXTURES / "overture_local_rich.jsonl")
        doc = engine.search_places(params(), fake.io(), cache=self.cache, adapter=adapter)
        contract.validate_contract(doc)
        self.assertEqual(len(doc["places"]), 3)
        self.assertTrue(all(p["id"].startswith("overture:") for p in doc["places"]))
        self.assertTrue(any("Overture" in a for a in doc["attributions"]))
        # the OSM *data* attribution is absent (the Valhalla routing line may
        # legitimately mention OpenStreetMap data)
        self.assertNotIn(config.OSM_ATTRIBUTION, doc["attributions"])
        self.assertTrue(any("local Overture extract" in w for w in doc["warnings"]))
        # routing (local Valhalla) may run, but no Overpass mirror was ever called
        self.assertTrue(fake.calls)  # sanity: routing really happened
        self.assertFalse(any("overpass" in url for url in fake.calls), fake.calls)

    def test_local_incomplete_completes_via_overpass_merge(self):
        # the dupes extract holds only 2 distinct cafes (< limit 3): Overpass
        # must be queried and its results merged with the local candidates
        fake = FakeNet({"overpass_de": overpass_responder("overpass_cafe.json"),
                        "valhalla_local": valhalla_ok()})
        adapter = overture.JsonlAdapter(FIXTURES / "overture_dupes.jsonl")
        doc = engine.search_places(params(), fake.io(), cache=self.cache, adapter=adapter)
        contract.validate_contract(doc)
        self.assertTrue(any("overpass" in url for url in fake.calls))  # Overpass was asked
        ids = [p["id"] for p in doc["places"]]
        self.assertTrue(any(i.startswith("osm:") for i in ids))
        self.assertTrue(any(i.startswith("overture:") for i in ids))
        joined = " ".join(doc["attributions"])
        self.assertIn("OpenStreetMap", joined)
        self.assertIn("Overture", joined)
        self.assertTrue(any("merged" in w for w in doc["warnings"]))
        self.assertEqual(len(ids), len(set(ids)))  # dedupe ran across sources

    def test_local_incomplete_overpass_down_serves_partial_extract(self):
        # 2 distinct local candidates, mirrors dead: serve the partial extract
        # honestly instead of the cache or an error
        fake = FakeNet({"overpass_de": net.Timeout("t"), "overpass_kumi": net.Timeout("t"),
                        "valhalla_local": valhalla_ok()})
        adapter = overture.JsonlAdapter(FIXTURES / "overture_dupes.jsonl")
        doc = engine.search_places(params(), fake.io(), cache=self.cache, adapter=adapter)
        contract.validate_contract(doc)
        names = [p["name"] for p in doc["places"]]
        self.assertIn("Second Venue", names)
        self.assertTrue(any("incomplete" in w for w in doc["warnings"]))
        self.assertTrue(any("Overture" in a for a in doc["attributions"]))

    def test_broken_extract_falls_back_to_live_providers(self):
        # an unreadable extract must never break the lookup: live path unchanged
        missing = overture.JsonlAdapter(FIXTURES / "does_not_exist.jsonl")
        fake = FakeNet({"overpass_de": overpass_responder("overpass_cafe.json"),
                        "valhalla": valhalla_ok()})
        doc = engine.search_places(params(), fake.io(), cache=self.cache, adapter=missing)
        contract.validate_contract(doc)
        self.assertTrue(all(p["id"].startswith("osm:") for p in doc["places"]))
        self.assertFalse(any("overture" in w.lower() for w in doc["warnings"]))

    def test_overture_sources_become_verifiable_source_name(self):
        # records carrying dataset names get a per-place attribution like
        # "Overture Maps (Foursquare, Meta)"; records without them are unchanged
        adapter = overture.JsonlAdapter(FIXTURES / "overture_sources.jsonl")
        fake = FakeNet({"valhalla_local": valhalla_ok()})  # local-first: no Overpass

        def one(name):
            doc = engine.search_places(params(filters={"name_contains": name}),
                                       fake.io(), cache=self.cache, adapter=adapter)
            contract.validate_contract(doc)
            (place,) = doc["places"]
            return place

        coin = one("coin")
        self.assertEqual(coin["source"]["name"], "Overture Maps (Foursquare, Meta)")
        self.assertEqual(coin["source"]["url"], "https://overturemaps.org")
        self.assertEqual(one("roastery")["source"]["name"], "Overture Maps")
        long_tail = one("long tail")
        self.assertLessEqual(len(long_tail["source"]["name"]), 80)  # contract cap
        self.assertIn("(X", long_tail["source"]["name"])  # only the first entry fit
        self.assertNotIn("Meta", long_tail["source"]["name"])  # overflowing tail dropped

    def test_overture_fallback_when_mirrors_fail(self):
        fake = FakeNet({"overpass_de": net.Timeout("t"), "overpass_kumi": net.HttpStatus(503, "x"),
                        "valhalla": valhalla_ok()})
        adapter = overture.JsonlAdapter(FIXTURES / "overture_cafes.jsonl")
        doc = engine.search_places(params(), fake.io(), cache=self.cache, adapter=adapter)
        contract.validate_contract(doc)
        self.assertTrue(all(p["id"].startswith("overture:") for p in doc["places"]))
        self.assertTrue(any("Overture" in a for a in doc["attributions"]))
        self.assertTrue(any("overture" in w.lower() for w in doc["warnings"]))
        for p in doc["places"]:
            self.assertNotIn("rating", p)
            self.assertNotIn("reviews", p)

    def test_cached_last_good_when_everything_fails(self):
        fake = happy_net()
        engine.search_places(params(), fake.io(), cache=self.cache)
        broken = FakeNet({"overpass_de": net.Timeout("t"), "overpass_kumi": net.Timeout("t")})
        doc = engine.search_places(params(), broken.io(), cache=self.cache)
        contract.validate_contract(doc)
        self.assertEqual(len(doc["places"]), 3)
        self.assertTrue(any("last-good cache" in w for w in doc["warnings"]))
        self.assertFalse(any("stale" in w for w in doc["warnings"]))
        # cache preserves the original provider fetch time
        self.assertEqual(doc["places"][0]["source"]["fetched_at"], NOW)

    def test_stale_cache_warns(self):
        fake = happy_net()
        engine.search_places(params(), fake.io(), cache=self.cache)
        # age the single entry beyond the TTL
        data = cache_mod.LastGoodCache(self.home, "default")._load()
        for entry in data["entries"].values():
            entry["fetched_at"] = "2020-01-01T00:00:00Z"
        cache_mod.LastGoodCache(self.home, "default")._save(data)
        broken = FakeNet({"overpass_de": net.Timeout("t"), "overpass_kumi": net.Timeout("t")})
        doc = engine.search_places(params(), broken.io(), cache=self.cache)
        self.assertTrue(any("stale" in w for w in doc["warnings"]))

    def test_route_fallback_straight_line_is_honest(self):
        fake = FakeNet({"overpass_de": overpass_responder("overpass_cafe.json"),
                        "valhalla": net.DecodeError("bad"),
                        "osrm_foot": b'{"code": "NoRoute"}'})
        doc = engine.search_places(params(), fake.io(), cache=self.cache)
        for place in doc["places"]:
            self.assertEqual(place["distance"]["kind"], "straight_line")
            self.assertNotIn("seconds", place["distance"])
            self.assertEqual(place["distance"]["source"], "haversine")
        self.assertTrue(any("straight-line" in w for w in doc["warnings"]))
        self.assertFalse(any("Valhalla" in a for a in doc["attributions"]))

    def test_dedupe_unit_mixed_sources_keeps_richer_record(self):
        osm = {"source_id": "osm:node/1001", "name": "Cafe du Coin", "lat": 48.85702,
               "lon": 2.35152, "address": "12 Rue de la Lune, Paris", "category": "cafe",
               "features": {"wifi": True, "power_outlets": None}, "tags": {}}
        ovt = {"source_id": "overture:xyz", "name": "Cafe du Coin", "lat": 48.85703,
               "lon": 2.35153, "address": None, "category": "cafe", "features": None, "tags": {}}
        far = {"source_id": "overture:far", "name": "Cafe du Coin", "lat": 48.87000,
               "lon": 2.37000, "address": None, "category": "cafe", "features": None, "tags": {}}
        merged = engine.dedupe([ovt, osm, far, dict(osm)])
        self.assertEqual(len(merged), 2)  # 75m proximity merges; 1.4km away stays
        winner = next(p for p in merged if p["lat"] < 48.86)
        self.assertEqual(winner["source_id"], "osm:node/1001")  # richer record wins

    def test_fallback_dedupes_duplicate_rows_in_extract(self):
        dup = FIXTURES / "overture_dupes.jsonl"
        fake = FakeNet({"overpass_de": net.Timeout("t"), "overpass_kumi": net.HttpStatus(503, "x"),
                        "valhalla": valhalla_ok()})
        adapter = overture.JsonlAdapter(dup)
        doc = engine.search_places(params(), fake.io(), cache=self.cache, adapter=adapter)
        names = [p["name"] for p in doc["places"]]
        self.assertEqual(names.count("Overture Only Roastery"), 1)
        ids = [p["id"] for p in doc["places"]]
        self.assertEqual(len(ids), len(set(ids)))

    def test_deterministic_ranking(self):
        doc1 = engine.search_places(params(), happy_net().io(), cache=self.cache)
        cache2 = cache_mod.LastGoodCache(self.home, "default")
        doc2 = engine.search_places(params(), happy_net().io(), cache=cache2)
        self.assertEqual([p["id"] for p in doc1["places"]], [p["id"] for p in doc2["places"]])
        self.assertEqual(doc1["places"], doc2["places"])

    def test_filters_name_contains(self):
        fake = happy_net()
        doc = engine.search_places(params(filters={"name_contains": "atlas"}),
                                   fake.io(), cache=self.cache)
        self.assertEqual([p["name"] for p in doc["places"]], ["Cafe Atlas"])

    def test_filters_wheelchair(self):
        fake = happy_net()
        doc = engine.search_places(params(filters={"wheelchair": True}),
                                   fake.io(), cache=self.cache)
        self.assertEqual([p["name"] for p in doc["places"]], ["Cafe Atlas"])

    def test_unknown_filter_warns_and_ignored(self):
        fake = happy_net()
        doc = engine.search_places(params(filters={"vegan_only": True}),
                                   fake.io(), cache=self.cache)
        self.assertTrue(any("unknown filter" in w for w in doc["warnings"]))
        self.assertEqual(len(doc["places"]), 3)

    def test_japanese_text_preserved(self):
        fake = FakeNet({"overpass_de": overpass_responder("overpass_japanese.json"),
                        "valhalla": valhalla_ok()})
        origin = (35.68130, 139.76780)
        doc = engine.search_places(
            engine.SearchParams("cafe", origin[0], origin[1], 300, 3), fake.io(),
            cache=cache_mod.LastGoodCache(self.home, "default"))
        contract.validate_contract(doc)
        names = [p["name"] for p in doc["places"]]
        self.assertIn("珈琲舎のだ 東京駅店", names)
        self.assertIn("カフェ・ラ・ネージュ", names)
        rendered = contract.render(doc)
        self.assertIn("珈琲舎".encode("utf-8").decode("utf-8"), rendered)

    def test_no_precise_origin_in_cache_file(self):
        fake = happy_net()
        engine.search_places(params(), fake.io(), cache=self.cache)
        raw = self.cache.path.read_text("utf-8")
        data = json.loads(raw)
        # the cache key is a grid hash, not coordinates
        (key,) = data["entries"].keys()
        self.assertNotIn("48.8", key)
        self.assertNotIn("2.35", key)
        # POI coordinates are provider data and legitimately cached, but the
        # caller's exact origin must not appear verbatim
        self.assertNotIn("48.857, 2.351", raw)
        self.assertNotIn("2.3519", raw)


if __name__ == "__main__":
    unittest.main()
