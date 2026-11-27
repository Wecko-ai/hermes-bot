"""Bounded, allowlisted HTTP for the places plugin.

Only URLs byte-identical to an entry of :data:`places.core.config.ENDPOINTS`
are ever contacted, over HTTPS, with short timeouts and response-size caps.
Tests inject a fake ``opener`` so nothing here ever touches the network in CI.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Callable, Optional

from . import config, sanitize


class NetError(Exception):
    """Base class for bounded-network failures (message is safe to surface)."""


class UrlNotAllowed(NetError):
    """The URL is not on the endpoint allowlist (refused before any I/O)."""


class Timeout(NetError):
    pass


class ResponseTooLarge(NetError):
    pass


class HttpStatus(NetError):
    def __init__(self, status: int, endpoint_key: str):
        super().__init__(f"{endpoint_key}: HTTP {status}")
        self.status = status
        self.endpoint_key = endpoint_key


class DecodeError(NetError):
    pass


class Budget:
    """Whole-call time budget shared by every network step."""

    def __init__(self, total_s: float = config.TOTAL_BUDGET_S, clock: Callable[[], float] = time.monotonic):
        self._total = float(total_s)
        self._start = clock()
        self._clock = clock

    def remaining(self) -> float:
        return max(0.0, self._total - (self._clock() - self._start))

    def take(self, want: float) -> float:
        """Clamp a requested timeout to what is left; 0 means 'give up now'."""
        return min(float(want), self.remaining())

    def exhausted(self) -> bool:
        return self.remaining() <= 0.05


@dataclass
class Io:
    """Injectable I/O seam: ``opener`` replaces urllib, ``clock``/``now_iso``
    make time deterministic in tests."""

    opener: Optional[Callable] = None  # (request: urllib.request.Request, timeout: float) -> bytes
    clock: Callable[[], float] = time.monotonic
    now_iso: Callable[[], str] = sanitize.iso_now

    def open(self, request: urllib.request.Request, timeout: float, max_bytes: int) -> bytes:
        if self.opener is not None:
            return self.opener(request, timeout)
        return _default_opener(request, timeout, max_bytes)


def _default_opener(request: urllib.request.Request, timeout: float, max_bytes: int) -> bytes:
    endpoint = _check_allowlist(request.full_url)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:  # noqa: S310 (allowlist-gated)
            status = getattr(resp, "status", 200)
            if status != 200:
                raise HttpStatus(int(status), endpoint.key)
            return resp.read(max_bytes + 1)
    except urllib.error.HTTPError as exc:
        raise HttpStatus(exc.code, endpoint.key) from None
    except (TimeoutError, urllib.error.URLError) as exc:
        reason = getattr(exc, "reason", exc)
        if isinstance(reason, TimeoutError) or "timed out" in str(reason).lower():
            raise Timeout(str(reason)) from None
        raise NetError(f"connection failed: {type(exc).__name__}") from None


def _check_allowlist(url: str) -> config.Endpoint:
    for endpoint in config.ENDPOINTS.values():
        if url == endpoint.url or url.startswith(endpoint.url + "?") or url.startswith(endpoint.url + "/"):
            return endpoint
    raise UrlNotAllowed(f"URL not allowlisted for the places plugin: {url!r}")


def request_bytes(
    method: str,
    url: str,
    *,
    body: bytes | None = None,
    headers: Optional[dict] = None,
    timeout_s: float,
    max_bytes: int,
    io: Io | None = None,
) -> bytes:
    """One bounded request to an allowlisted endpoint.

    Raises :class:`UrlNotAllowed` before any I/O for non-allowlisted URLs,
    :class:`ResponseTooLarge` when the body exceeds ``max_bytes``.
    """
    endpoint = _check_allowlist(url)
    if timeout_s <= 0:
        raise Timeout("no time budget left")
    req = urllib.request.Request(
        url,
        data=body,
        method=method.upper(),
        headers={
            "User-Agent": "hermes-places-plugin/0.1 (+https://www.openstreetmap.org)",
            "Accept": "application/json",
            **{str(k): str(v) for k, v in (headers or {}).items()},
        },
    )
    io = io or Io()
    data = io.open(req, min(float(timeout_s), endpoint.timeout_s), max_bytes)
    if data is None:
        raise NetError("empty response")
    data = bytes(data)
    if len(data) > max_bytes:
        raise ResponseTooLarge(f"response exceeds {max_bytes} bytes")
    return data


def request_json(method: str, url: str, *, body: bytes | None = None,
                 headers: Optional[dict] = None, timeout_s: float,
                 max_bytes: int, io: Io | None = None):
    raw = request_bytes(method, url, body=body, headers=headers, timeout_s=timeout_s,
                        max_bytes=max_bytes, io=io)
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise DecodeError(f"invalid JSON from provider: {type(exc).__name__}") from None
