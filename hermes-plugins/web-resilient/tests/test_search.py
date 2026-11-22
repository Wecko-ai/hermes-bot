"""Search failover behaviour: primary failure/fallback, all-down, empty-vs-error,
malformed responses, timeouts, circuit breaking, caching, and log redaction.
All offline: both backends are replaced by in-process fakes.
"""
from __future__ import annotations

import logging
import os
import unittest

from web_resilient._contract import search_fail, search_ok, title_hit
from web_resilient.provider import ResilientWebSearchProvider


def hits(*titles):
    return [title_hit(t, f"https://example.com/{i}", f"desc {i}", i + 1) for i, t in enumerate(titles)]


def raising(exc):
    def _fn(*args, **kwargs):
        raise exc

    return _fn


class EnvCase(unittest.TestCase):
    def setUp(self):
        self._saved = dict(os.environ)
        os.environ.pop("SEARXNG_URL", None)
        for key in [k for k in os.environ if k.startswith("RESILIENT_")]:
            del os.environ[key]

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._saved)


def make_provider(searxng_url=None, searxng=None, ddgs=None, ddgs_importable=True):
    """Fresh provider with fake backends; ``SEARXNG_URL`` env set when given. Env is
    cleaned up by :class:`EnvCase`'s tearDown."""
    if searxng_url:
        os.environ["SEARXNG_URL"] = searxng_url
    p = ResilientWebSearchProvider()

    def _searxng_fn(base_url, query, limit, *, timeout):
        if isinstance(searxng, Exception):
            raise searxng
        return searxng(base_url, query, limit, timeout=timeout)

    def _ddgs_fn(query, limit, *, timeout):
        if isinstance(ddgs, Exception):
            raise ddgs
        return ddgs(query, limit, timeout=timeout)

    p._searxng_call = _searxng_fn  # noqa: SLF001
    p._ddgs_call = _ddgs_fn  # noqa: SLF001
    p._ddgs_importable = staticmethod(lambda: ddgs_importable)  # type: ignore[assignment]
    return p


class TestFailover(EnvCase):
    def test_primary_success_no_fallback(self):
        calls = []
        p = make_provider(
            "http://localhost:8080",
            searxng=lambda base, q, l, **kw: calls.append(("s", q)) or hits("a"),
            ddgs=lambda q, l, **kw: calls.append(("d", q)) or hits("b"),
        )
        resp = p.search("hello", 3)
        self.assertTrue(resp["success"])
        self.assertEqual([c[0] for c in calls], ["s"])
        self.assertEqual(resp["data"]["web"][0]["title"], "a")

    def test_primary_failure_falls_back(self):
        from web_resilient._searxng import SearXNGError

        p = make_provider(
            "http://localhost:8080",
            searxng=SearXNGError("HTTP 500"),
            ddgs=lambda q, l, **kw: hits("fallback"),
        )
        resp = p.search("hello", 3)
        self.assertTrue(resp["success"])
        self.assertEqual(resp["data"]["web"][0]["title"], "fallback")

    def test_failover_when_searxng_not_configured(self):
        p = make_provider(None, ddgs=lambda q, l, **kw: hits("ddg"))
        resp = p.search("hello", 3)
        self.assertTrue(resp["success"])
        self.assertEqual(resp["data"]["web"][0]["title"], "ddg")

    def test_all_down_fails_honestly(self):
        from web_resilient._ddgs import DDGSError
        from web_resilient._searxng import SearXNGError

        p = make_provider(
            "http://localhost:8080",
            searxng=SearXNGError("connection refused"),
            ddgs=DDGSError("rate limited"),
        )
        resp = p.search("hello", 3)
        self.assertFalse(resp["success"])
        self.assertIn("searxng: connection refused", resp["error"])
        self.assertIn("ddgs: rate limited", resp["error"])

    def test_no_backend_at_all(self):
        p = make_provider(None, ddgs_importable=False)
        resp = p.search("hello", 3)
        self.assertFalse(resp["success"])
        self.assertIn("no search backend", resp["error"])

    def test_exact_legacy_shapes(self):
        p = make_provider(None, ddgs=lambda q, l, **kw: [title_hit("T", "https://u", "D", 1)])
        resp = p.search("hello", 3)
        self.assertEqual(resp, search_ok([title_hit("T", "https://u", "D", 1)]))
        self.assertEqual(list(resp["data"]["web"][0].keys()), ["title", "url", "description", "position"])
        p2 = make_provider(None, ddgs=RuntimeError("boom"))
        fail = p2.search("hello", 3)
        self.assertEqual(set(fail.keys()), set(search_fail("x").keys()))

    def test_empty_query_refused_without_touching_backends(self):
        p = make_provider(
            "http://localhost:8080",
            searxng=AssertionError("backend must not be called"),
        )
        resp = p.search("   ", 3)
        self.assertFalse(resp["success"])


class TestEmptyVsError(EnvCase):
    def test_both_empty_is_success_not_error(self):
        p = make_provider(
            "http://localhost:8080",
            searxng=lambda *a, **kw: [],
            ddgs=lambda *a, **kw: [],
        )
        resp = p.search("nothing-matches-this", 3)
        self.assertTrue(resp["success"])
        self.assertEqual(resp["data"]["web"], [])

    def test_primary_empty_secondary_has_results(self):
        p = make_provider(
            "http://localhost:8080",
            searxng=lambda *a, **kw: [],
            ddgs=lambda *a, **kw: hits("found"),
        )
        resp = p.search("q", 3)
        self.assertTrue(resp["success"])
        self.assertEqual(resp["data"]["web"][0]["title"], "found")


class TestMalformed(EnvCase):
    def _opener(self, body, status=200):
        class FakeResp:
            def __init__(self, data, code):
                self._data = data
                self.status = code

            def read(self, n=-1):
                return self._data

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        return lambda request, timeout=None: FakeResp(body, status)

    def test_non_json_is_malformed(self):
        from web_resilient._searxng import SearXNGError, searxng_search

        with self.assertRaises(SearXNGError):
            searxng_search("http://localhost:8080", "q", 5, timeout=5, opener=self._opener(b"<html>nope</html>"))

    def test_non_dict_envelope_is_malformed(self):
        from web_resilient._searxng import SearXNGError, searxng_search

        with self.assertRaises(SearXNGError):
            searxng_search("http://localhost:8080", "q", 5, timeout=5, opener=self._opener(b"[1,2,3]"))

    def test_bad_results_field_is_malformed(self):
        from web_resilient._searxng import SearXNGError, searxng_search

        with self.assertRaises(SearXNGError):
            searxng_search("http://localhost:8080", "q", 5, timeout=5, opener=self._opener(b'{"results": {"a": 1}}'))

    def test_malformed_searxng_falls_back_to_ddgs(self):
        provider = make_provider(
            "http://localhost:8080",
            searxng=SearXNGErrorFactory("garbage"),
            ddgs=lambda *a, **kw: hits("ddg"),
        )
        # Reproduce malformed-JSON at the backend level via the opener seam.
        from web_resilient import _searxng as sx

        def broken_sx(base_url, query, limit, *, timeout):
            return sx.searxng_search(base_url, query, limit, timeout=timeout, opener=self._opener(b"garbage{{"))

        provider._searxng_call = broken_sx  # noqa: SLF001
        resp = provider.search("q", 3)
        self.assertTrue(resp["success"])
        self.assertEqual(resp["data"]["web"][0]["title"], "ddg")

    def test_http_error_raises(self):
        from web_resilient._searxng import SearXNGError, searxng_search

        with self.assertRaises(SearXNGError) as ctx:
            searxng_search("http://localhost:8080", "q", 5, timeout=5, opener=self._opener(b"server error", status=503))
        self.assertIn("503", str(ctx.exception))

    def test_worker_envelope_malformed(self):
        from web_resilient import _ddgs as dd

        class Proc:
            def poll(self):
                return 1

        with self.assertRaises(dd.DDGSError):
            dd._parse_envelope("not json", Proc())
        with self.assertRaises(dd.DDGSError):
            dd._parse_envelope('{"ok": true, "results": {"x": 1}}', Proc())
        with self.assertRaises(dd.DDGSError):
            dd._parse_envelope("", Proc())
        self.assertEqual(dd._parse_envelope('{"ok": true, "results": []}', Proc()), [])


def SearXNGErrorFactory(message):
    from web_resilient._searxng import SearXNGError

    return SearXNGError(message)


class TestTimeouts(EnvCase):
    def test_ddgs_timeout_reported(self):
        p = make_provider(None, ddgs=TimeoutError("DuckDuckGo search timed out after 30s"))
        resp = p.search("q", 3)
        self.assertFalse(resp["success"])
        self.assertIn("timed out", resp["error"])

    def test_searxng_timeout_falls_back(self):
        p = make_provider(
            "http://localhost:8080",
            searxng=TimeoutError("read timed out"),
            ddgs=lambda *a, **kw: hits("ok"),
        )
        resp = p.search("q", 3)
        self.assertTrue(resp["success"])
        self.assertEqual(resp["data"]["web"][0]["title"], "ok")

    def test_run_in_child_hard_timeout(self):
        """A worker that never answers is terminated: TimeoutError, no long block."""
        import time as _time

        from web_resilient import _ddgs as dd

        class HungProc:
            def __init__(self):
                self.killed = False

            def communicate(self, _request):
                # Simulates native code that never returns; wakes to observe the kill.
                for _ in range(600):
                    if self.killed:
                        return "", ""
                    _time.sleep(0.05)
                return "", ""

            def poll(self):
                return None if not self.killed else -9

            def terminate(self):
                pass

            def kill(self):
                self.killed = True

        start = _time.monotonic()
        with self.assertRaises(TimeoutError):
            dd._run_in_child("q", 5, timeout=0.3, spawn=lambda env: HungProc(), interrupt=lambda: False)
        self.assertLess(_time.monotonic() - start, 5)

    def test_run_in_child_interrupt(self):
        import time as _t

        from web_resilient import _ddgs as dd

        class SlowProc:
            def __init__(self):
                self.killed = False

            def communicate(self, _request):
                for _ in range(600):
                    if self.killed:
                        return "", ""
                    _t.sleep(0.05)
                return "", ""

            def poll(self):
                return None

            def terminate(self):
                pass

            def kill(self):
                self.killed = True

        with self.assertRaises(dd._Interrupted):
            dd._run_in_child("q", 5, timeout=30, spawn=lambda env: SlowProc(), interrupt=lambda: True)


class TestCircuitBreaker(EnvCase):
    def test_opens_after_threshold_and_recovers(self):
        import unittest.mock as mock

        from web_resilient import _circuit

        breaker = _circuit.CircuitBreaker(failure_threshold=2, cooldown_seconds=60)
        breaker.on_failure()
        self.assertTrue(breaker.allow())
        breaker.on_failure()
        self.assertFalse(breaker.allow())
        with mock.patch.object(_circuit.time, "monotonic", return_value=1e9):
            self.assertTrue(breaker.allow())

    def test_provider_skips_open_backend(self):
        """Once ddgs's circuit opens, a total outage must NOT keep paying ddgs's timeout."""
        ddgs_calls = []
        sx_calls = []
        sx_alive = {"up": False}

        def sx_fn(base, q, l, **kw):
            sx_calls.append(1)
            if not sx_alive["up"]:
                raise RuntimeError("sx down")
            return hits("s")

        def ddgs_fn(q, l, **kw):
            ddgs_calls.append(1)
            raise RuntimeError("ddgs down")

        p = make_provider("http://localhost:8080", searxng=sx_fn, ddgs=ddgs_fn)
        # SearXNG gets a wider breaker so this test can open only ddgs's circuit.
        from web_resilient._circuit import CircuitBreaker

        p.circuits["searxng"] = CircuitBreaker(failure_threshold=10, cooldown_seconds=60)
        # Total outage: both backends fail and are tried each call (distinct queries:
        # successes are cached, failures are not). After 3 rounds ddgs's circuit opens.
        for i in range(3):
            self.assertFalse(p.search(f"outage-{i}", 3)["success"])
        self.assertFalse(p.circuits["ddgs"].allow())
        self.assertEqual(len(ddgs_calls), 3)
        # SearXNG recovers; ddgs stays down but its circuit is open — never called.
        sx_alive["up"] = True
        self.assertTrue(p.search("recovered", 3)["success"])
        self.assertEqual(len(ddgs_calls), 3)
        # Total outage again: ddgs must be skipped (open circuit), call count frozen.
        sx_alive["up"] = False
        self.assertFalse(p.search("outage-again", 3)["success"])
        self.assertEqual(len(ddgs_calls), 3)
        self.assertEqual(len(sx_calls), 5)

    def test_success_resets_circuit(self):
        p = make_provider(
            "http://localhost:8080",
            searxng=raising(RuntimeError("boom")),
            ddgs=lambda *a, **kw: hits("d"),
        )
        p.search("q1", 3)
        p.search("q2", 3)
        self.assertEqual(p.circuits["searxng"].failures, 2)
        p._searxng_call = lambda *a, **kw: hits("ok")  # noqa: SLF001
        p.search("q3", 3)
        self.assertEqual(p.circuits["searxng"].failures, 0)


class TestCache(EnvCase):
    def test_second_call_uses_cache(self):
        calls = []
        p = make_provider(
            "http://localhost:8080",
            searxng=lambda base, q, l, **kw: calls.append(q) or hits("a"),
            ddgs=lambda *a, **kw: hits("b"),
        )
        r1 = p.search("cached query", 3)
        r2 = p.search("cached query", 3)
        self.assertEqual(r1, r2)
        self.assertEqual(len(calls), 1)

    def test_failures_are_not_cached(self):
        attempts = []

        def flaky(q, l, **kw):
            attempts.append(1)
            if len(attempts) == 1:
                raise RuntimeError("down")
            return hits("x")

        p = make_provider(None, ddgs=flaky)
        self.assertFalse(p.search("q", 3)["success"])
        self.assertTrue(p.search("q", 3)["success"])
        self.assertEqual(len(attempts), 2)

    def test_cache_key_includes_limit(self):
        calls = []
        p = make_provider(
            "http://localhost:8080",
            searxng=lambda base, q, l, **kw: calls.append((q, l)) or hits("a"),
        )
        p.search("q", 3)
        p.search("q", 10)
        self.assertEqual(calls, [("q", 3), ("q", 10)])

    def test_cache_scoped_to_home_and_profile(self):
        from web_resilient import _cache

        os.environ["HERMES_HOME"] = "/tmp/home-one"
        os.environ["HERMES_PROFILE"] = "alpha"
        self.assertEqual(_cache.hermes_scope(), "/tmp/home-one|alpha")
        os.environ["HERMES_PROFILE"] = "beta"
        self.assertEqual(_cache.hermes_scope(), "/tmp/home-one|beta")

    def test_cache_ttl_expiry(self):
        import unittest.mock as mock

        from web_resilient._cache import SuccessCache

        cache = SuccessCache(ttl_seconds=10)
        with mock.patch("web_resilient._cache.time.monotonic", return_value=0.0):
            cache.set(("k",), "v")
            self.assertEqual(cache.get(("k",)), "v")
        with mock.patch("web_resilient._cache.time.monotonic", return_value=11.0):
            self.assertIsNone(cache.get(("k",)))

    def test_cache_is_bounded(self):
        from web_resilient._cache import SuccessCache

        cache = SuccessCache(ttl_seconds=60, max_entries=2)
        cache.set(("a",), 1)
        cache.set(("b",), 2)
        cache.set(("c",), 3)
        self.assertEqual(len(cache), 2)


class TestLogRedaction(EnvCase):
    def test_raw_query_never_logged(self):
        secret = "my-secret-query-do-not-log"
        logger = logging.getLogger("web_resilient.provider")
        p = make_provider(None, ddgs=RuntimeError("down"))
        with self.assertLogs(logger, level="INFO") as captured:
            p.search(secret, 3)
        transcript = "\n".join(r.getMessage() for r in captured.records)
        self.assertNotIn(secret, transcript)
        self.assertIn("len=", transcript)  # correlation tag present instead

    def test_cache_hit_logs_tag_not_query(self):
        secret = "another-sensitive-query"
        logger = logging.getLogger("web_resilient.provider")
        p = make_provider("http://localhost:8080", searxng=lambda base, q, l, **kw: hits("a"))
        p.search(secret, 3)
        with self.assertLogs(logger, level="INFO") as captured:
            p.search(secret, 3)
        transcript = "\n".join(r.getMessage() for r in captured.records)
        self.assertNotIn(secret, transcript)


if __name__ == "__main__":
    unittest.main()
