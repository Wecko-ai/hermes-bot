"""SSRF protection for local HTTP fetches.

Only ``http``/``https`` URLs with a hostname are allowed. The hostname is
resolved with DNS and *every* resolved address is checked: private, loopback,
link-local (including cloud metadata 169.254.169.254), multicast, reserved and
unspecified ranges are refused. Extraction applies this to the URL and to every
redirect hop. The single narrow exception is the explicitly configured
loopback SearXNG origin, honoured only by the SearXNG search backend.

:func:`resolve_public_target` returns the *validated* ``getaddrinfo`` rows so
the caller can connect to one of those exact addresses instead of re-resolving
the hostname — closing the DNS-rebinding TOCTOU window between "DNS checked"
and "hostname used for the connection".
"""
from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse


class BlockedURL(ValueError):
    """Raised when a URL must not be fetched (scheme, host kind, or DNS answer)."""


def parse_http_url(url: str):
    """Parse and scheme-check; returns the ``SplitResult``. Raises :class:`BlockedURL`."""
    if not isinstance(url, str) or not url.strip():
        raise BlockedURL("empty URL")
    parsed = urlparse(url.strip())
    if parsed.scheme not in ("http", "https"):
        raise BlockedURL(f"unsupported URL scheme: {parsed.scheme or '(none)'}")
    if not parsed.hostname:
        raise BlockedURL("URL has no hostname")
    try:  # a malformed port (e.g. stray colon) must be a refusal, not a crash
        parsed.port
    except ValueError as exc:
        raise BlockedURL(f"URL has an invalid port: {exc}") from exc
    return parsed


def _is_public_ip(ip: ipaddress._BaseAddress) -> bool:
    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def resolve_public_target(url: str, *, allow_loopback_origin: str | None = None) -> list[tuple]:
    """Validate ``url``'s target and return the *pinned*, validated addrinfos.

    Returns ``(family, socktype, proto, canonname, sockaddr)`` rows — every
    address in them is public — so the caller can open its socket against one
    of these exact addresses and never re-resolve the hostname (DNS-rebinding
    TOCTOU). Callers MUST connect to a returned address, not to the hostname.

    ``allow_loopback_origin``: narrow exception — a normalized ``scheme://host:port``
    origin (the configured SearXNG instance) that may answer on loopback/private
    addresses. Any other host, or a loopback IP given directly in the URL, is
    still refused; the exception matches the configured origin's hostname only
    (a *name* that resolves to 127.0.0.1 is allowed for this origin, a literal
    ``http://127.0.0.1`` URL is not — the configured origin is operator-supplied,
    an in-text IP is attacker-supplied). For the exception match this returns
    an empty list: that path connects by name (operator-configured origin).
    """
    parsed = parse_http_url(url)
    host = parsed.hostname.lower()
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    if allow_loopback_origin:
        allowed = urlparse(allow_loopback_origin)
        if (
            parsed.scheme == allowed.scheme
            and host == (allowed.hostname or "").lower()
            and port == (allowed.port or (443 if allowed.scheme == "https" else 80))
        ):
            return []
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        ip = None
    if ip is not None:
        if not _is_public_ip(ip):
            raise BlockedURL(f"URL targets a non-public address: {host}")
        family = socket.AF_INET6 if ip.version == 6 else socket.AF_INET
        sockaddr = (str(ip), port, 0, 0) if ip.version == 6 else (str(ip), port)
        return [(family, socket.SOCK_STREAM, 6, "", sockaddr)]
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise BlockedURL(f"DNS resolution failed for {host}: {exc}") from exc
    if not infos:
        raise BlockedURL(f"DNS resolution returned no addresses for {host}")
    for info in infos:
        addr = info[4][0]
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError as exc:  # unexpected family payload
            raise BlockedURL(f"DNS returned an unusable address for {host}: {addr!r}") from exc
        if not _is_public_ip(ip):
            raise BlockedURL(f"URL host {host} resolves to a non-public address: {addr}")
    return infos


def assert_public_target(url: str, *, allow_loopback_origin: str | None = None) -> None:
    """Resolve and validate ``url``'s target; raise :class:`BlockedURL` when not public.

    Thin wrapper over :func:`resolve_public_target` for callers that connect by
    name (the SearXNG urllib path); extraction uses the pinned rows instead.
    """
    resolve_public_target(url, allow_loopback_origin=allow_loopback_origin)
