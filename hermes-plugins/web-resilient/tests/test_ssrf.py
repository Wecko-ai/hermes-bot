"""SSRF guard: scheme/hostname validation, DNS-based blocking of private,
loopback, link-local/metadata, multicast and reserved targets, the narrow
configured-SearXNG loopback exception, and DNS failure handling. All offline.
"""
from __future__ import annotations

import socket
import unittest
import unittest.mock as mock

from web_resilient._ssrf import BlockedURL, assert_public_target, parse_http_url
from web_resilient._searxng import searxng_search

SEARXNG_ORIGIN = "http://localhost:8080"


def dns_mapping(mapping, default=None):
    """``socket.getaddrinfo`` replacement: hostname -> IP list."""
    def _fake(host, port, *args, **kwargs):
        ips = mapping.get(host, default if default is not None else [])
        if not ips:
            raise OSError(f"Name or service not known: {host}")
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port)) for ip in ips]

    return _fake


class TestSchemeAndHost(unittest.TestCase):
    def test_non_http_schemes_rejected(self):
        for url in ("javascript:alert(1)", "ftp://example.com/x", "file:///etc/passwd", "data:text/html,x"):
            with self.assertRaises(BlockedURL, msg=url):
                parse_http_url(url)

    def test_missing_hostname_rejected(self):
        with self.assertRaises(BlockedURL):
            parse_http_url("http:///path")

    def test_empty_url_rejected(self):
        with self.assertRaises(BlockedURL):
            parse_http_url("   ")


class TestLiteralIPs(unittest.TestCase):
    def test_blocked_ranges(self):
        for ip in (
            "127.0.0.1", "127.0.0.53", "[::1]",
            "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1",
            "169.254.169.254",  # cloud metadata
            "0.0.0.0", "224.0.0.1", "240.0.0.1",
            "[fe80::1]", "[fd00::1]",
        ):
            with self.assertRaises(BlockedURL, msg=ip):
                assert_public_target(f"http://{ip}/")

    def test_public_ip_allowed(self):
        assert_public_target("https://93.184.216.34/page")  # no DNS needed, no raise

    def test_public_ip_with_port_allowed(self):
        assert_public_target("https://93.184.216.34:8443/page")


class TestDnsResolution(unittest.TestCase):
    def test_domain_resolving_to_private_blocked(self):
        with mock.patch(
            "web_resilient._ssrf.socket.getaddrinfo",
            side_effect=dns_mapping({"evil.example": ["10.0.0.9"]}),
        ):
            with self.assertRaises(BlockedURL) as ctx:
                assert_public_target("http://evil.example/")
            self.assertIn("10.0.0.9", str(ctx.exception))

    def test_domain_resolving_to_metadata_blocked(self):
        with mock.patch(
            "web_resilient._ssrf.socket.getaddrinfo",
            side_effect=dns_mapping({"meta.example": ["169.254.169.254"]}),
        ):
            with self.assertRaises(BlockedURL):
                assert_public_target("http://meta.example/latest/meta-data/")

    def test_mixed_answers_one_private_blocks(self):
        with mock.patch(
            "web_resilient._ssrf.socket.getaddrinfo",
            side_effect=dns_mapping({"mixed.example": ["93.184.216.34", "192.168.0.5"]}),
        ):
            with self.assertRaises(BlockedURL):
                assert_public_target("http://mixed.example/")

    def test_public_domain_allowed(self):
        with mock.patch(
            "web_resilient._ssrf.socket.getaddrinfo",
            side_effect=dns_mapping({"ok.example": ["93.184.216.34"]}),
        ):
            assert_public_target("https://ok.example/page")

    def test_dns_failure_blocked(self):
        with mock.patch(
            "web_resilient._ssrf.socket.getaddrinfo",
            side_effect=dns_mapping({}, default=[]),
        ):
            with self.assertRaises(BlockedURL):
                assert_public_target("http://unresolvable.example/")


class TestSearXNGException(unittest.TestCase):
    """The single narrow loopback exception: only the configured SearXNG origin."""

    def test_configured_loopback_origin_allowed(self):
        with mock.patch(
            "web_resilient._ssrf.socket.getaddrinfo",
            side_effect=dns_mapping({"localhost": ["127.0.0.1"]}),
        ):
            assert_public_target("http://localhost:8080/search?q=x", allow_loopback_origin=SEARXNG_ORIGIN)

    def test_wrong_port_refused(self):
        with mock.patch(
            "web_resilient._ssrf.socket.getaddrinfo",
            side_effect=dns_mapping({"localhost": ["127.0.0.1"]}),
        ):
            with self.assertRaises(BlockedURL):
                assert_public_target("http://localhost:9090/search?q=x", allow_loopback_origin=SEARXNG_ORIGIN)

    def test_wrong_scheme_refused(self):
        with mock.patch(
            "web_resilient._ssrf.socket.getaddrinfo",
            side_effect=dns_mapping({"localhost": ["127.0.0.1"]}),
        ):
            with self.assertRaises(BlockedURL):
                assert_public_target("https://localhost:8080/search?q=x", allow_loopback_origin=SEARXNG_ORIGIN)

    def test_literal_loopback_ip_still_refused(self):
        """An operator-configured origin may be a *name* resolving to loopback; a raw
        loopback IP in a URL is attacker-supplied and never allowed."""
        with self.assertRaises(BlockedURL):
            assert_public_target("http://127.0.0.1:8080/search?q=x", allow_loopback_origin=SEARXNG_ORIGIN)

    def test_exception_does_not_leak_to_extract(self):
        """Extraction calls the guard with no exception — the origin match is opt-in only."""
        with mock.patch(
            "web_resilient._ssrf.socket.getaddrinfo",
            side_effect=dns_mapping({"localhost": ["127.0.0.1"]}),
        ):
            with self.assertRaises(BlockedURL):
                assert_public_target("http://localhost:8080/page")  # no allow_loopback_origin

    def test_searxng_search_uses_exception_with_real_opener(self):
        """End-to-end at the backend level: loopback SearXNG serves results."""
        import json as _json

        class FakeResp:
            status = 200

            def read(self, n=-1):
                return _json.dumps({"results": [{"title": "T", "url": "https://u", "content": "C", "score": 5}]}).encode()

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        with mock.patch(
            "web_resilient._ssrf.socket.getaddrinfo",
            side_effect=dns_mapping({"localhost": ["127.0.0.1"]}),
        ):
            rows = searxng_search(SEARXNG_ORIGIN, "q", 5, timeout=5, opener=lambda req, timeout=None: FakeResp())
        self.assertEqual(rows[0]["title"], "T")
        self.assertEqual(rows[0]["position"], 1)


if __name__ == "__main__":
    unittest.main()
