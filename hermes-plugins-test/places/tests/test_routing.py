"""Routing: Valhalla first, OSRM fallback, honest haversine last."""

from __future__ import annotations

import unittest

from places.tests.helpers import FakeNet, osrm_ok, valhalla_ok

from places.core import net, routing

ORIGIN = (48.8570, 2.3519)
DEST = (48.85702, 2.35152)


class RoutingTests(unittest.TestCase):
    def _route(self, fake: FakeNet):
        return routing.route(ORIGIN, DEST, fake.io(), net.Budget(clock=fake.clock))

    def test_local_valhalla_preferred(self):
        fake = FakeNet({"valhalla_local": valhalla_ok(), "valhalla": valhalla_ok(), "osrm_foot": osrm_ok()})
        distance, attribution = self._route(fake)
        self.assertEqual(distance["kind"], "route")
        self.assertEqual(distance["source"], "valhalla_local")
        self.assertAlmostEqual(distance["meters"], 62.0)
        self.assertEqual(distance["seconds"], 45)
        self.assertIn("local Valhalla", attribution)
        self.assertEqual(len(fake.calls), 1)

    def test_public_valhalla_after_local_failure(self):
        fake = FakeNet({"valhalla_local": net.NetError("offline"), "valhalla": valhalla_ok(), "osrm_foot": osrm_ok()})
        distance, attribution = self._route(fake)
        self.assertEqual(distance["source"], "valhalla")
        self.assertIn("Valhalla", attribution)
        self.assertEqual(len(fake.calls), 2)  # OSRM never touched

    def test_osrm_fallback(self):
        fake = FakeNet({"valhalla": net.Timeout("slow"), "osrm_foot": osrm_ok()})
        distance, attribution = self._route(fake)
        self.assertEqual(distance["source"], "osrm_foot")
        self.assertAlmostEqual(distance["meters"], 63.4)
        self.assertIn("OSRM", attribution)
        self.assertEqual(len(fake.calls), 3)

    def test_both_fail_uses_haversine_without_seconds(self):
        fake = FakeNet({"valhalla": net.DecodeError("bad"), "osrm_foot": net.DecodeError("bad")})
        distance, attribution = self._route(fake)
        self.assertEqual(distance["kind"], "straight_line")
        self.assertEqual(distance["source"], "haversine")
        self.assertNotIn("seconds", distance)  # never fake a walking time
        self.assertIsNone(attribution)

    def test_malformed_valhalla_payload_falls_back(self):
        fake = FakeNet({"valhalla": b'{"trip": {}}', "osrm_foot": osrm_ok()})
        distance, _ = self._route(fake)
        self.assertEqual(distance["source"], "osrm_foot")

    def test_implausible_route_figures_rejected(self):
        fake = FakeNet({"valhalla": valhalla_ok(length_km=9000.0), "osrm_foot": osrm_ok()})
        distance, _ = self._route(fake)
        self.assertEqual(distance["source"], "osrm_foot")

    def test_osrm_no_route_code_falls_back(self):
        fake = FakeNet({"valhalla": net.Timeout("t"),
                        "osrm_foot": b'{"code": "NoRoute"}'})
        distance, _ = self._route(fake)
        self.assertEqual(distance["kind"], "straight_line")


if __name__ == "__main__":
    unittest.main()
