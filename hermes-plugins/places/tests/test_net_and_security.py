"""Allowlist enforcement, size caps, budget and sanitization."""

from __future__ import annotations

import unittest
import urllib.request
from unittest.mock import patch

from places.tests.helpers import FakeClock, FakeNet  # noqa: F401  (path bootstrap)

from places.core import config, net, sanitize


class AllowlistTests(unittest.TestCase):
    def test_arbitrary_url_refused_before_io(self):
        fake = FakeNet()
        io = fake.io()
        with self.assertRaises(net.UrlNotAllowed):
            net.request_json("GET", "https://evil.example.com/x", timeout_s=5,
                             max_bytes=1000, io=io)
        with self.assertRaises(net.UrlNotAllowed):
            net.request_json("GET", "http://overpass-api.de/api/interpreter", timeout_s=5,
                             max_bytes=1000, io=io)
        self.assertEqual(fake.calls, [])  # nothing was sent

    def test_allowlisted_query_string_ok(self):
        fake = FakeNet({"valhalla": b"{}"})
        io = fake.io()
        url = config.ENDPOINTS["valhalla"].url + "?json=%7B%7D"
        net.request_json("GET", url, timeout_s=5, max_bytes=1000, io=io)
        self.assertEqual(len(fake.calls), 1)

    def test_allowlist_self_check_clean(self):
        self.assertEqual(config.validate_allowlist(), [])

    def test_response_size_cap(self):
        fake = FakeNet({"valhalla": b"x" * 2000})
        io = fake.io()
        with self.assertRaises(net.ResponseTooLarge):
            net.request_json("GET", config.ENDPOINTS["valhalla"].url, timeout_s=5,
                             max_bytes=1000, io=io)

    def test_invalid_json_decode_error(self):
        fake = FakeNet({"valhalla": b"not json{"})
        io = fake.io()
        with self.assertRaises(net.DecodeError):
            net.request_json("GET", config.ENDPOINTS["valhalla"].url, timeout_s=5,
                             max_bytes=1000, io=io)

    def test_http_status_wrapped(self):
        fake = FakeNet({"valhalla": net.HttpStatus(504, "valhalla")})
        io = fake.io()
        with self.assertRaises(net.HttpStatus):
            net.request_json("GET", config.ENDPOINTS["valhalla"].url, timeout_s=5,
                             max_bytes=1000, io=io)

    def test_default_opener_reads_only_cap_plus_one(self):
        class Response:
            status = 200
            read_arg = None

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, amount):
                self.read_arg = amount
                return b"x" * amount

        response = Response()
        with patch.object(urllib.request, "urlopen", return_value=response):
            net._default_opener(
                urllib.request.Request(config.ENDPOINTS["valhalla"].url), 1.0, 1000)
        self.assertEqual(response.read_arg, 1001)


class BudgetTests(unittest.TestCase):
    def test_exhaustion(self):
        clock = FakeClock()  # constant until we move it
        budget = net.Budget(total_s=25.0, clock=clock)
        clock.t = 20.0
        self.assertEqual(budget.take(6.0), 5.0)   # only 5s left
        clock.t = 10.0
        self.assertEqual(budget.take(6.0), 6.0)   # time cannot run backwards
        clock.t = 30.0
        self.assertTrue(budget.exhausted())
        self.assertEqual(budget.take(6.0), 0.0)


class SanitizeTests(unittest.TestCase):
    def test_control_characters_and_bidi_stripped(self):
        dirty = "caf\u00e9 \u202eEVIL\u0000name\u0007!"
        cleaned = sanitize.clean_text(dirty, 100)
        self.assertNotIn("\u0000", cleaned)
        self.assertNotIn("\u0007", cleaned)
        self.assertNotIn("\u202e", cleaned)
        self.assertIn("caf\u00e9", cleaned)

    def test_truncation_is_bounded(self):
        long_text = "a" * 500
        self.assertEqual(len(sanitize.clean_text(long_text, 10)), 10)

    def test_normalize_name_cross_script(self):
        self.assertEqual(sanitize.normalize_name("Caf\u00e9  du   Coin"), "cafeducoin")
        self.assertEqual(sanitize.normalize_name("\u73c8\u7432\u820e\u306e\u3060"), "\u73c8\u7432\u820e\u306e\u3060")

    def test_iso_roundtrip_and_age(self):
        self.assertIsNotNone(sanitize.parse_iso("2026-01-15T12:00:00Z"))
        self.assertIsNone(sanitize.parse_iso("not a date"))
        self.assertGreater(sanitize.iso_age_seconds("2020-01-01T00:00:00Z"), 1000)


if __name__ == "__main__":
    unittest.main()
