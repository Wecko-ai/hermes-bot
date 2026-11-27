"""Pinned DNS resolution, TLS context selection and SNI: the DNS-rebinding
TOCTOU is closed by resolving once and connecting to the validated address,
with the original hostname kept for TLS SNI / certificate identity and the
Hermes platform trust store used when available.

All tests are offline. The end-to-end tests use real sockets against a real
``http.server`` bound to 127.0.0.1 — localhost only, never the network — with
the SSRF guard widened for loopback and DNS replaced by a fake mapping, which
is exactly what proves the fetch connects to the pinned IP instead of
re-resolving the hostname.
"""
from __future__ import annotations

import contextlib
import http.server
import socket
import ssl
import sys
import threading
import types
import unittest
import unittest.mock as mock

from web_resilient import _extract, _ssrf
from web_resilient._extract import _connect_pinned, _https_context, _open_validated_socket, fetch_page
from web_resilient._ssrf import _is_public_ip as _real_is_public_ip
from web_resilient._ssrf import parse_http_url, resolve_public_target

PUBLIC_V4 = "93.184.216.34"
PUBLIC_V6 = "2606:2800:220:1:248:1893:25c8:1946"


class CountingDns:
    """``getaddrinfo`` replacement: fixed hostname→IP mapping, recording calls and
    optionally refusing any lookup beyond ``max_calls`` (a re-resolution is the
    DNS-rebinding window this module must not have)."""

    def __init__(self, mapping, *, max_calls=None):
        self.mapping = mapping
        self.calls: list[tuple[str, int]] = []
        self.max_calls = max_calls

    def __call__(self, host, port, *args, **kwargs):
        if self.max_calls is not None and len(self.calls) >= self.max_calls:
            raise AssertionError(f"hostname {host!r} re-resolved — the connection must be pinned")
        self.calls.append((host, port))
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (self.mapping[host], port))]


@contextlib.contextmanager
def allow_loopback():
    """Widen the SSRF guard for loopback only — test-only, for the local server."""
    with mock.patch.object(
        _ssrf, "_is_public_ip", lambda ip: ip.is_loopback or _real_is_public_ip(ip)
    ):
        yield


class TestResolvePublicTarget(unittest.TestCase):
    def test_returns_validated_addrinfos(self):
        dns = CountingDns({"ok.example": PUBLIC_V4})
        with mock.patch("web_resilient._ssrf.socket.getaddrinfo", side_effect=dns):
            infos = resolve_public_target("https://ok.example/page")
        self.assertEqual(len(dns.calls), 1)
        self.assertEqual(infos[0][4], (PUBLIC_V4, 443))
        self.assertEqual(infos[0][1], socket.SOCK_STREAM)

    def test_default_port_for_http(self):
        dns = CountingDns({"ok.example": PUBLIC_V4})
        with mock.patch("web_resilient._ssrf.socket.getaddrinfo", side_effect=dns):
            infos = resolve_public_target("http://ok.example/page")
        self.assertEqual(infos[0][4], (PUBLIC_V4, 80))

    def test_private_answer_refused(self):
        with mock.patch(
            "web_resilient._ssrf.socket.getaddrinfo",
            side_effect=CountingDns({"evil.example": "10.0.0.9"}),
        ):
            with self.assertRaises(_ssrf.BlockedURL):
                resolve_public_target("http://evil.example/")

    def test_literal_public_ipv6_sockaddr(self):
        infos = resolve_public_target(f"https://[{PUBLIC_V6}]/page")
        self.assertEqual(infos[0][0], socket.AF_INET6)
        self.assertEqual(infos[0][4], (PUBLIC_V6, 443, 0, 0))

    def test_literal_public_ipv4_sockaddr(self):
        infos = resolve_public_target(f"http://{PUBLIC_V4}/page")
        self.assertEqual(infos[0][0], socket.AF_INET)
        self.assertEqual(infos[0][4], (PUBLIC_V4, 80))

    def test_loopback_origin_exception_returns_empty(self):
        infos = resolve_public_target(
            "http://localhost:8080/search?q=x", allow_loopback_origin="http://localhost:8080"
        )
        self.assertEqual(infos, [])


class TestHttpsContext(unittest.TestCase):
    def test_prefers_hermes_platform_context(self):
        sentinel = object()
        fake_agent = types.ModuleType("agent")
        fake_agent.__path__ = []  # type: ignore[attr-defined]
        fake_ssl_verify = types.ModuleType("agent.ssl_verify")
        fake_ssl_verify.platform_ssl_context = lambda: sentinel
        with mock.patch.dict(
            sys.modules, {"agent": fake_agent, "agent.ssl_verify": fake_ssl_verify}
        ):
            self.assertIs(_https_context(), sentinel)

    def test_falls_back_to_stdlib_default(self):
        saved = {k: sys.modules.get(k) for k in ("agent", "agent.ssl_verify")}
        sys.modules.pop("agent.ssl_verify", None)
        sys.modules.pop("agent", None)
        try:
            ctx = _https_context()
        finally:
            for key, mod in saved.items():
                if mod is None:
                    sys.modules.pop(key, None)
                else:
                    sys.modules[key] = mod
        self.assertIsInstance(ctx, ssl.SSLContext)
        self.assertEqual(ctx.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(ctx.check_hostname)


class TestConnectPinned(unittest.TestCase):
    def test_https_wraps_with_sni_and_selected_context(self):
        parsed = parse_http_url("https://example.com/page")
        infos = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (PUBLIC_V4, 443))]
        fake_sock = object()
        seen = {}

        class FakeContext:
            def wrap_socket(self, sock, server_hostname=None):
                seen["sni"] = server_hostname
                seen["ctx"] = self
                return ("tls", sock, server_hostname)

        fake_ctx = FakeContext()
        with mock.patch.object(_extract, "_open_validated_socket", return_value=fake_sock) as opener, \
            mock.patch.object(_extract, "_https_context", return_value=fake_ctx):
            result = _connect_pinned(parsed, infos, 5.0)
        opener.assert_called_once_with(infos, 5.0)
        self.assertIs(seen["ctx"], fake_ctx)
        self.assertEqual(seen["sni"], "example.com")
        self.assertEqual(result[1], fake_sock)

    def test_http_not_tls_wrapped(self):
        parsed = parse_http_url("http://example.com/page")
        infos = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (PUBLIC_V4, 80))]
        fake_sock = object()
        with mock.patch.object(_extract, "_open_validated_socket", return_value=fake_sock), \
            mock.patch.object(_extract, "_https_context", side_effect=AssertionError("no TLS for http")):
            self.assertIs(_connect_pinned(parsed, infos, 5.0), fake_sock)


class TestOpenValidatedSocket(unittest.TestCase):
    def test_tries_each_validated_address(self):
        attempts = []

        class FakeSock:
            def settimeout(self, _t):
                pass

            def connect(self, addr):
                attempts.append(addr)
                if len(attempts) == 1:
                    raise ConnectionRefusedError("refused")

            def close(self):
                pass

        infos = [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 443)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("2.2.2.2", 443)),
        ]
        with mock.patch.object(_extract.socket, "socket", side_effect=lambda *a: FakeSock()):
            sock = _open_validated_socket(infos, 1.0)
        self.assertEqual(attempts, [("1.1.1.1", 443), ("2.2.2.2", 443)])
        self.assertIsInstance(sock, FakeSock)

    def test_all_refused_raises_oserror(self):
        class FakeSock:
            def settimeout(self, _t):
                pass

            def connect(self, addr):
                raise OSError("down")

            def close(self):
                pass

        infos = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 443))]
        with mock.patch.object(_extract.socket, "socket", side_effect=lambda *a: FakeSock()):
            with self.assertRaises(OSError):
                _open_validated_socket(infos, 1.0)


class _RecordingHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.server.requests.append((self.headers.get("Host"), self.path))
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", self.server.redirect_to)
            self.end_headers()
            return
        body = b"<html><head><title>Pinned</title></head><body><p>hello pinned</p></body></html>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


def make_server(redirect_to=None):
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _RecordingHandler)
    server.requests = []
    server.redirect_to = redirect_to
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def stop_server(server):
    server.shutdown()
    server.server_close()


def no_internal_dns_connect():
    """Tripwire: http.client must never do its own (re-resolving) connect."""
    return mock.patch(
        "socket.create_connection",
        side_effect=AssertionError("http.client must not do its own DNS connect"),
    )


class TestPinnedEndToEnd(unittest.TestCase):
    """Real loopback sockets; DNS faked and pinned. Proves the connection goes to
    the validated address with the right Host header, and the hostname is never
    re-resolved (a second lookup would be the rebinding window)."""

    def test_fetch_pins_connection_single_lookup(self):
        server = make_server()
        try:
            dns = CountingDns({"pinned.test": "127.0.0.1"}, max_calls=1)
            with allow_loopback(), \
                mock.patch("web_resilient._ssrf.socket.getaddrinfo", side_effect=dns), \
                no_internal_dns_connect():
                final, ctype, text = fetch_page(f"http://pinned.test:{server.server_port}/page?secret=1")
            self.assertEqual(final, f"http://pinned.test:{server.server_port}/page?secret=1")
            self.assertIn("text/html", ctype)
            self.assertIn("hello pinned", text)
            self.assertEqual(len(dns.calls), 1)
            self.assertEqual(server.requests[0], (f"pinned.test:{server.server_port}", "/page?secret=1"))
        finally:
            stop_server(server)

    def test_dns_answer_swap_between_check_and_connect_has_no_effect(self):
        """Simulated rebinding: a second lookup would return the private address,
        but pinning means the question is never asked again."""
        server = make_server()
        try:
            dns = CountingDns({"rebind.test": "127.0.0.1"}, max_calls=1)
            with allow_loopback(), \
                mock.patch("web_resilient._ssrf.socket.getaddrinfo", side_effect=dns), \
                no_internal_dns_connect():
                final, _ctype, text = fetch_page(f"http://rebind.test:{server.server_port}/")
            self.assertIn("hello pinned", text)
            self.assertEqual(len(dns.calls), 1)
        finally:
            stop_server(server)

    def test_every_redirect_hop_resolved_once_and_pinned(self):
        server_b = make_server()
        server_a = make_server(redirect_to=f"http://b.test:{server_b.server_port}/final")
        try:
            dns = CountingDns({"a.test": "127.0.0.1", "b.test": "127.0.0.1"}, max_calls=2)
            with allow_loopback(), \
                mock.patch("web_resilient._ssrf.socket.getaddrinfo", side_effect=dns), \
                no_internal_dns_connect():
                final, _ctype, text = fetch_page(f"http://a.test:{server_a.server_port}/redirect")
            self.assertEqual(final, f"http://b.test:{server_b.server_port}/final")
            self.assertIn("hello pinned", text)
            self.assertEqual(
                dns.calls,
                [("a.test", server_a.server_port), ("b.test", server_b.server_port)],
            )
            self.assertEqual(server_b.requests[0], (f"b.test:{server_b.server_port}", "/final"))
        finally:
            stop_server(server_a)
            stop_server(server_b)

    def test_redirect_hop_to_private_address_still_blocked(self):
        """Pinning must not weaken the guard: a hop resolving private is refused."""
        server = make_server(redirect_to="http://evil.test:8080/admin")
        try:
            dns = CountingDns({"a.test": "127.0.0.1", "evil.test": "10.0.0.9"}, max_calls=5)
            with allow_loopback(), \
                mock.patch("web_resilient._ssrf.socket.getaddrinfo", side_effect=dns), \
                no_internal_dns_connect():
                with self.assertRaises(_ssrf.BlockedURL):
                    fetch_page(f"http://a.test:{server.server_port}/redirect")
        finally:
            stop_server(server)


if __name__ == "__main__":
    unittest.main()
