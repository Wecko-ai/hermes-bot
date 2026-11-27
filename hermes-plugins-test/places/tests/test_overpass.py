"""Overpass mirror failover, retries, empty-vs-error, malformed data."""

from __future__ import annotations

import unittest

from places.tests.helpers import FakeNet, NOW, overpass_responder

from places.core import net, overpass

ORIGIN = (48.8570, 2.3519)


class OverpassTests(unittest.TestCase):
    def _search(self, fake: FakeNet):
        return overpass.search("cafe", ORIGIN[0], ORIGIN[1], 300, fake.io(), net.Budget(clock=fake.clock))

    def test_happy_path_parses_elements(self):
        fake = FakeNet({"overpass_de": overpass_responder("overpass_cafe.json")})
        pois, fetched_at = self._search(fake)
        self.assertEqual(fetched_at, NOW)
        ids = {p["source_id"] for p in pois}
        # unnamed and bad-coordinate elements are skipped
        self.assertEqual(ids, {"osm:node/1001", "osm:node/1002", "osm:way/2001"})
        cafe = next(p for p in pois if p["source_id"] == "osm:node/1001")
        self.assertEqual(cafe["name"], "Cafe du Coin")
        self.assertIn("Rue de la Lune", cafe["address"])
        self.assertEqual(cafe["features"], {"wifi": True, "power_outlets": None})
        ross = next(p for p in pois if p["source_id"] == "osm:way/2001")
        self.assertEqual(ross["features"]["power_outlets"], True)

    def test_first_mirror_fails_over_to_second(self):
        fake = FakeNet({
            "overpass_de": net.Timeout("timed out"),
            "overpass_kumi": overpass_responder("overpass_cafe.json"),
        })
        pois, _ = self._search(fake)
        self.assertTrue(pois)
        # mirror 1 is tried twice (initial + retry) before failing over
        self.assertEqual(len(fake.calls), 3)

    def test_retry_then_failover(self):
        fake = FakeNet({
            "overpass_de": net.HttpStatus(504, "overpass_de"),
            "overpass_kumi": overpass_responder("overpass_empty.json"),
        })
        pois, _ = self._search(fake)
        self.assertEqual(len(fake.calls), 3)  # 2 attempts on mirror 1, 1 on mirror 2
        self.assertEqual(pois, [])

    def test_all_mirrors_fail_raises(self):
        fake = FakeNet({
            "overpass_de": net.Timeout("a"),
            "overpass_kumi": net.HttpStatus(503, "overpass_kumi"),
        })
        with self.assertRaises(overpass.OverpassError) as ctx:
            self._search(fake)
        self.assertIn("all overpass mirrors failed", str(ctx.exception))
        self.assertEqual(len(fake.calls), 4)  # 2 attempts per mirror

    def test_empty_result_is_valid_not_an_error(self):
        fake = FakeNet({"overpass_de": overpass_responder("overpass_empty.json")})
        pois, _ = self._search(fake)
        self.assertEqual(pois, [])

    def test_malformed_document_raises(self):
        fake = FakeNet({"overpass_de": b'{"elements": "nope"}'})
        with self.assertRaises(overpass.OverpassError):
            self._search(fake)

    def test_missing_elements_raises(self):
        fake = FakeNet({"overpass_de": b'{"version": 0.6}'})
        with self.assertRaises(overpass.OverpassError):
            self._search(fake)

    def test_unknown_category_rejected(self):
        fake = FakeNet()
        with self.assertRaises(overpass.OverpassError):
            overpass.search("casino", ORIGIN[0], ORIGIN[1], 300, fake.io(), net.Budget(clock=fake.clock))

    def test_query_builder_bounds_and_tags(self):
        query = overpass.build_query([("amenity", "cafe")], 48.857, 2.3519, 300)
        self.assertIn('node["amenity"="cafe"](around:300,48.857000,2.351900);', query)
        self.assertIn("out center tags 25;", query)
        # the raw coordinates stay inside the query but never in logs
        self.assertNotIn("|", query)


if __name__ == "__main__":
    unittest.main()
