"""SearXNG search backend: ``GET {SEARXNG_URL}/search?q=...&format=json``.

Raises on any transport/parse/shape problem (the provider converts to a legacy
failure dict and fails over); returns a list of title-first hit rows on success.
"""
from __future__ import annotations

import json
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from ._contract import title_hit
from ._ssrf import assert_public_target


class SearXNGError(RuntimeError):
    """SearXNG answered with an error status, malformed JSON, or a wrong shape."""


def searxng_search(
    base_url: str,
    query: str,
    limit: int,
    *,
    timeout: float,
    opener=None,
) -> list[dict[str, Any]]:
    """Query the configured instance and normalize hits. ``opener`` is injectable for
    tests (callable ``(request, timeout) -> file-like``); defaults to ``urlopen``."""
    base_url = (base_url or "").rstrip("/")
    if not base_url:
        raise SearXNGError("SEARXNG_URL is not set")
    # Narrow SSRF exception: only the configured origin itself may be loopback/private.
    assert_public_target(f"{base_url}/", allow_loopback_origin=base_url)
    url = f"{base_url}/search?{urlencode({'q': query, 'format': 'json', 'pageno': 1})}"
    request = Request(url, headers={"Accept": "application/json", "User-Agent": "hermes-web-resilient/1.0"})
    open_fn = opener or urlopen
    try:
        with open_fn(request, timeout=timeout) as resp:
            status = getattr(resp, "status", 200)
            body = resp.read(2_000_000 + 1)
    except SearXNGError:
        raise
    except Exception as exc:
        raise SearXNGError(f"could not reach SearXNG: {exc}") from exc
    if status != 200:
        raise SearXNGError(f"SearXNG returned HTTP {status}")
    try:
        data = json.loads(body.decode("utf-8", errors="replace"))
    except ValueError as exc:
        raise SearXNGError(f"could not parse SearXNG response as JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise SearXNGError("SearXNG returned a malformed envelope (not an object)")
    raw_results = data.get("results", [])
    if not isinstance(raw_results, list):
        raise SearXNGError("SearXNG returned a malformed 'results' field")
    sorted_results = sorted(raw_results, key=lambda r: float(r.get("score", 0) or 0), reverse=True)[:limit]
    hits = []
    for i, r in enumerate(sorted_results):
        if not isinstance(r, dict):
            continue
        hits.append(title_hit(str(r.get("title", "")), str(r.get("url", "")), str(r.get("content", "")), i + 1))
    return hits
