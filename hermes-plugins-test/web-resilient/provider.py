"""ResilientWebSearchProvider: free search with runtime failover + local extraction.

Search order: configured SearXNG (``SEARXNG_URL``) first, then the free ``ddgs``
package — decided per call, not statically, with a per-backend circuit breaker
so a dead backend is skipped for its cooldown instead of adding its timeout to
every search. A backend returning a *successful empty* result does not trigger
failover by itself; the other backend is still tried, and an all-empty outcome
is reported as a successful empty list (empty ≠ error).

Exact legacy shapes are preserved (``search_ok``/``search_fail``/``title_hit``,
``document``/``page_error``). Queries are never logged raw — only
``len=<n> id=<hash>``. No paid provider, no keyless ring, no API key.
"""
from __future__ import annotations

import logging
from typing import Any, Callable, Optional

from ._cache import DEFAULT_MAX_ENTRIES, DEFAULT_TTL_SECONDS, SuccessCache, hermes_scope
from ._circuit import CircuitBreaker
from ._contract import WebSearchProvider, extract_fail, get_provider_env, search_fail, search_ok
from ._ddgs import SEARCH_TIMEOUT_SECS as DDGS_TIMEOUT_SECS
from ._ddgs import DDGSError, _Interrupted, ddgs_search
from ._extract import (
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_CHARS,
    DEFAULT_MAX_REDIRECTS,
    DEFAULT_TIMEOUT_SECS as EXTRACT_TIMEOUT_SECS,
    extract_page,
)
from ._redact import query_tag
from ._searxng import SearXNGError, searxng_search
from ._ssrf import BlockedURL

logger = logging.getLogger(__name__)

ENV_PREFIX = "RESILIENT_"
SEARXNG_TIMEOUT_SECS = 15.0
CIRCUIT_FAILURE_THRESHOLD = 3
CIRCUIT_COOLDOWN_SECS = 60.0


def _env_float(name: str, default: float) -> float:
    raw = get_provider_env(f"{ENV_PREFIX}{name}")
    try:
        return float(raw) if raw else default
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    raw = get_provider_env(f"{ENV_PREFIX}{name}")
    try:
        return int(raw) if raw else default
    except ValueError:
        return default


class ResilientWebSearchProvider(WebSearchProvider):
    """Failover search (SearXNG → DDGS) + bounded local HTTP extraction. Free, keyless."""

    NAME = "resilient"
    DISPLAY_NAME = "Resilient (SearXNG ⇄ DDGS, local extract)"

    # Test seams (module-level callables replaced by tests, never by config).
    _searxng_call: Callable[..., list[dict[str, Any]]] = staticmethod(searxng_search)
    _ddgs_call: Callable[..., list[dict[str, Any]]] = staticmethod(ddgs_search)
    _is_interrupted: Callable[[], bool] = staticmethod(lambda: False)

    name = property(lambda self: self.NAME)
    display_name = property(lambda self: self.DISPLAY_NAME)

    def __init__(self) -> None:
        self._cache = SuccessCache(
            ttl_seconds=_env_float("CACHE_TTL_SECONDS", DEFAULT_TTL_SECONDS),
            max_entries=_env_int("CACHE_MAX_ENTRIES", DEFAULT_MAX_ENTRIES),
        )
        self._circuits = {
            "searxng": CircuitBreaker(CIRCUIT_FAILURE_THRESHOLD, _env_float("CIRCUIT_COOLDOWN_SECONDS", CIRCUIT_COOLDOWN_SECS)),
            "ddgs": CircuitBreaker(CIRCUIT_FAILURE_THRESHOLD, _env_float("CIRCUIT_COOLDOWN_SECONDS", CIRCUIT_COOLDOWN_SECS)),
        }
        self._last_scope = hermes_scope()

    # -- availability ------------------------------------------------------
    def is_available(self) -> bool:
        """Cheap, no network: configured SearXNG URL or importable ddgs."""
        return bool(self._searxng_url()) or self._ddgs_importable()

    def supports_search(self) -> bool:
        return True

    def supports_extract(self) -> bool:
        return True

    @staticmethod
    def _searxng_url() -> str:
        return get_provider_env("SEARXNG_URL").rstrip("/")

    @staticmethod
    def _ddgs_importable() -> bool:
        try:
            import ddgs  # noqa: F401

            return True
        except ImportError:
            return False

    def get_setup_schema(self) -> dict[str, Any]:
        return {
            "name": self.DISPLAY_NAME,
            "badge": "free · no key · failover",
            "tag": "SearXNG (self-hosted) with automatic DDGS fallback; local HTTP extraction.",
            "env_vars": [
                {
                    "key": "SEARXNG_URL",
                    "prompt": "SearXNG instance URL (e.g. http://localhost:8080) — optional, ddgs alone works",
                    "url": "https://searx.space/",
                }
            ],
        }

    # -- search -------------------------------------------------------------
    def search(self, query: str, limit: int = 5) -> dict[str, Any]:
        """Fail over SearXNG → DDGS per call; cache brief successes per home/profile."""
        if not isinstance(query, str) or not query.strip():
            return search_fail("resilient search needs a non-empty 'query' string.")
        try:
            safe_limit = min(max(int(limit), 1), 100)
        except (TypeError, ValueError):
            safe_limit = 5
        if self._is_interrupted():
            return search_fail("Interrupted")

        scope = hermes_scope()
        cache_key = (scope, "search", query, safe_limit)
        cached = self._cache.get(cache_key)
        if cached is not None:
            logger.info("resilient search cache hit (%s)", query_tag(query))
            return cached

        errors: list[str] = []
        empty_success: Optional[dict[str, Any]] = None
        for backend in self._backend_order():
            if not self._circuits[backend].allow():
                logger.info("resilient search: %s circuit open, skipping (%s)", backend, query_tag(query))
                continue
            hits = self._try_backend(backend, query, safe_limit, errors)
            if hits is None:
                continue  # hard failure recorded in errors; circuit tripped
            response = search_ok(hits)
            self._circuits[backend].on_success()
            if not hits and empty_success is None:
                empty_success = response  # empty ≠ error: keep trying other backends
                continue
            self._cache.set(cache_key, response)
            logger.info("resilient search via %s: %d result(s) (%s)", backend, len(hits), query_tag(query))
            return response

        if empty_success is not None:
            self._cache.set(cache_key, empty_success)
            return empty_success
        detail = "; ".join(errors) if errors else "no search backend is configured or importable"
        logger.warning("resilient search failed on all backends (%s)", query_tag(query))
        return search_fail(f"All free search backends failed ({detail})")

    def _backend_order(self) -> list[str]:
        order: list[str] = []
        if self._searxng_url():
            order.append("searxng")
        if self._ddgs_importable():
            order.append("ddgs")
        return order

    def _try_backend(self, backend: str, query: str, limit: int, errors: list[str]) -> Optional[list[dict[str, Any]]]:
        """One backend attempt → hit rows, or None on failure (error appended, circuit tripped)."""
        try:
            if backend == "searxng":
                hits = self._searxng_call(
                    self._searxng_url(), query, limit, timeout=SEARXNG_TIMEOUT_SECS
                )
            else:
                hits = self._ddgs_call(query, limit, timeout=DDGS_TIMEOUT_SECS)
        except _Interrupted:
            errors.append(f"{backend}: interrupted")
            logger.info("resilient search: %s interrupted (%s)", backend, query_tag(query))
        except TimeoutError:
            errors.append(f"{backend}: timed out")
            self._circuits[backend].on_failure()
            logger.warning("resilient search: %s timed out (%s)", backend, query_tag(query))
        except (SearXNGError, DDGSError, BlockedURL, OSError, ValueError) as exc:
            errors.append(f"{backend}: {exc}")
            self._circuits[backend].on_failure()
            logger.warning("resilient search: %s failed: %s (%s)", backend, exc, query_tag(query))
        except Exception as exc:
            errors.append(f"{backend}: {exc}")
            self._circuits[backend].on_failure()
            logger.warning("resilient search: %s unexpected failure: %s (%s)", backend, exc, query_tag(query))
        else:
            return hits
        return None

    # -- extract -------------------------------------------------------------
    def extract(self, urls: list[str], **kwargs: Any) -> Any:
        """Bounded local HTTP extraction, one entry per URL, in order. Unknown kwargs
        (``format``, ``include_raw``, ``max_chars``) are accepted and ignored — the
        dispatcher owns truncation."""
        if self._is_interrupted():
            return [{"url": u, "error": "Interrupted", "title": ""} for u in urls]
        try:
            url_list = [str(u) for u in urls]
        except TypeError:
            return extract_fail([str(urls)], "extract expects a list of URLs")
        return [
            extract_page(
                u,
                timeout=_env_float("EXTRACT_TIMEOUT_SECONDS", EXTRACT_TIMEOUT_SECS),
                max_bytes=_env_int("EXTRACT_MAX_BYTES", DEFAULT_MAX_BYTES),
                max_chars=_env_int("EXTRACT_MAX_CHARS", DEFAULT_MAX_CHARS),
                max_redirects=_env_int("EXTRACT_MAX_REDIRECTS", DEFAULT_MAX_REDIRECTS),
            )
            for u in url_list
        ]

    # -- internals (test seams) ------------------------------------------------
    @property
    def cache(self) -> SuccessCache:
        return self._cache

    @property
    def circuits(self) -> dict[str, CircuitBreaker]:
        return self._circuits
