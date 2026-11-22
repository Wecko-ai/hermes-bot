"""Bounded local HTTP extraction for ``web_extract``.

Fetches pages over plain HTTP (no browser, no JS execution) with hard caps on
time, bytes, redirects and output; parses with Trafilatura when it is installed
and otherwise with a safe stdlib ``html.parser`` text extractor. Every hop —
initial URL and each redirect — passes the SSRF guard: only http/https, and the
host must resolve to public addresses (no loopback/private/link-local/metadata;
there is deliberately NO loopback exception here: extraction never touches the
local SearXNG or anything else internal).

DNS is resolved once per hop and the connection is pinned to one of the
*validated* addresses, so a hostname whose DNS answer is swapped between the
check and the connect (DNS rebinding) cannot redirect the fetch to an internal
address. TLS keeps the original hostname as SNI and certificate identity, and
uses the Hermes platform trust store when available.
"""
from __future__ import annotations

import html
import http.client
import logging
import re
import socket
import ssl
from html.parser import HTMLParser
from typing import Any, Callable, Optional
from urllib.parse import urljoin, urlunparse

from ._contract import document, page_error
from ._redact import redact_url
from ._ssrf import BlockedURL, parse_http_url, resolve_public_target

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT_SECS = 20.0
DEFAULT_MAX_BYTES = 2_000_000
DEFAULT_MAX_CHARS = 50_000
DEFAULT_MAX_REDIRECTS = 5

_HTML_TYPES = ("text/html", "application/xhtml+xml", "text/plain", "application/xml", "text/xml")
_USER_AGENT = "hermes-web-resilient/1.0 (+local extraction)"


class ExtractError(RuntimeError):
    """Per-page fetch failure (blocked, timeout, HTTP error, oversized, undecodable)."""


class _TextExtractor(HTMLParser):
    """Safe stdlib HTML→text fallback: drops script/style/noscript content and
    markup, unescapes entities, collapses blank runs. Hostile page text is data,
    never instructions — it is passed through verbatim minus tags."""

    _DROP = {"script", "style", "noscript", "template", "svg"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._drop_depth = 0
        self._chunks: list[str] = []
        self.title: str = ""

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag in self._DROP:
            self._drop_depth += 1
        elif tag in ("p", "br", "div", "li", "tr", "h1", "h2", "h3", "h4", "section", "article"):
            self._chunks.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self._DROP and self._drop_depth:
            self._drop_depth -= 1

    def handle_data(self, data: str) -> None:
        if not self._drop_depth:
            self._chunks.append(data)

    def text(self) -> str:
        raw = html.unescape("".join(self._chunks))
        lines = [re.sub(r"[ \t]+", " ", line).strip() for line in raw.splitlines()]
        return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


class _TitleExtractor(HTMLParser):
    """Best-effort <title> capture for pages Trafilatura does not handle."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._in_title = False
        self.title: str = ""

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag == "title":
            self._in_title = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._in_title and not self.title:
            self.title = data.strip()


def _charset_from_content_type(value: str) -> str:
    match = re.search(r"charset=([\w.\-]+)", value or "", re.IGNORECASE)
    return match.group(1) if match else "utf-8"


def _decode_body(body: bytes, content_type: str) -> str:
    for encoding in (_charset_from_content_type(content_type), "utf-8"):
        try:
            return body.decode(encoding, errors="strict")
        except (LookupError, UnicodeDecodeError):
            continue
    return body.decode("utf-8", errors="replace")


def _is_htmlish(content_type: str) -> bool:
    media_type = (content_type or "").split(";", 1)[0].strip().lower()
    if not media_type:
        return True  # missing content-type: try to parse anyway
    return any(media_type.startswith(t) for t in _HTML_TYPES)


def _https_context() -> ssl.SSLContext:
    """Client TLS context: the Hermes platform trust store when available
    (``agent.ssl_verify.platform_ssl_context`` — macOS Security.framework /
    Windows CryptoAPI / Linux store, plus ``SSL_CERT_FILE`` on top), else the
    stdlib default (which also honours ``SSL_CERT_FILE``). Verification is
    never disabled."""
    try:
        from agent.ssl_verify import platform_ssl_context  # type: ignore[import-not-found]

        return platform_ssl_context()
    except Exception:
        return ssl.create_default_context()


def _open_validated_socket(infos: list[tuple], timeout: float) -> socket.socket:
    """Open a TCP connection to one of the already-validated addresses — the
    hostname is never re-resolved, so the DNS answer cannot change between the
    SSRF check and the connect (DNS-rebinding TOCTOU)."""
    last_exc: Optional[OSError] = None
    for info in infos:
        sock = socket.socket(info[0], info[1], info[2])
        sock.settimeout(timeout)
        try:
            sock.connect(info[4])
            return sock
        except OSError as exc:
            last_exc = exc
            sock.close()
    raise last_exc or OSError("no validated address available")


def _connect_pinned(parsed, infos: list[tuple], timeout: float) -> socket.socket:
    """Pin the connection to a validated address; TLS SNI and certificate check
    keep the original hostname. Returns a connected (and for https, TLS-wrapped)
    socket ready to assign to ``conn.sock``."""
    sock = _open_validated_socket(infos, timeout)
    if parsed.scheme == "https":
        sock = _https_context().wrap_socket(sock, server_hostname=parsed.hostname)
    return sock


def _connection(parsed, timeout: float) -> http.client.HTTPConnection:
    host = parsed.hostname
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    if parsed.scheme == "https":
        return http.client.HTTPSConnection(host, port, timeout=timeout, context=_https_context())
    return http.client.HTTPConnection(host, port, timeout=timeout)


def fetch_page(
    url: str,
    *,
    timeout: float = DEFAULT_TIMEOUT_SECS,
    max_bytes: int = DEFAULT_MAX_BYTES,
    max_redirects: int = DEFAULT_MAX_REDIRECTS,
    connect: Optional[Callable[..., socket.socket]] = None,
) -> tuple[str, str, str]:
    """Fetch ``url`` with caps → ``(final_url, content_type, text)``.

    ``connect`` is an injectable socket factory for tests (never used to bypass
    the SSRF guard — validation happens before it is called). Raises
    :class:`ExtractError` / :class:`BlockedURL`."""
    current = url
    for _hop in range(max(1, max_redirects) + 1):
        # Every hop, no loopback exception. Resolution happens ONCE here and the
        # connection below is pinned to one of these validated addresses.
        infos = resolve_public_target(current)
        parsed = parse_http_url(current)
        try:
            conn = _connection(parsed, timeout)
            if connect is None:
                conn.sock = _connect_pinned(parsed, infos, timeout)
            else:
                # Test seam: replace only the TCP connect, keep http.client semantics.
                host, port = parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)
                sock = connect((host, port), timeout=timeout)
                if parsed.scheme == "https":
                    sock = _https_context().wrap_socket(sock, server_hostname=parsed.hostname)
                conn.sock = sock
            path = urlunparse(("", "", parsed.path or "/", parsed.params, parsed.query, ""))
            conn.request("GET", path, headers={"User-Agent": _USER_AGENT, "Accept": "text/html,text/plain;q=0.9,*/*;q=0.1"})
            resp = conn.getresponse()
            status = resp.status
            if status in (301, 302, 303, 307, 308):
                location = resp.getheader("Location") or ""
                resp.read(8192)
                conn.close()
                if not location:
                    raise ExtractError(f"HTTP {status} redirect without Location header")
                if _hop >= max_redirects:
                    raise ExtractError(f"too many redirects (>{max_redirects})")
                current = urljoin(current, location)
                continue
            if status >= 400:
                body = resp.read(4096)
                conn.close()
                raise ExtractError(f"HTTP {status} from origin: {_decode_body(body, resp.getheader('Content-Type') or '')[:200]}")
            content_type = resp.getheader("Content-Type") or ""
            if not _is_htmlish(content_type):
                conn.close()
                raise ExtractError(f"unsupported content type: {content_type or '(missing)'}")
            body = resp.read(max_bytes + 1)
            conn.close()
        except (BlockedURL, ExtractError):
            raise
        except (OSError, http.client.HTTPException) as exc:
            raise ExtractError(f"fetch failed: {exc}") from exc
        if len(body) > max_bytes:
            raise ExtractError(f"page exceeds {max_bytes}-byte cap")
        return current, content_type, _decode_body(body, content_type)
    raise ExtractError(f"too many redirects (>{max_redirects})")  # pragma: no cover - loop guard


def html_to_text(html_text: str) -> tuple[str, str]:
    """``(title, text)`` via Trafilatura when installed, else the stdlib extractor."""
    try:
        import trafilatura  # type: ignore[import-not-found]

        text = trafilatura.extract(html_text, include_comments=False, favor_recall=False) or ""
        if text.strip():
            title_m = re.search(r"<title[^>]*>(.*?)</title>", html_text, re.IGNORECASE | re.DOTALL)
            title = html.unescape(re.sub(r"<[^>]+>", "", title_m.group(1)).strip()) if title_m else ""
            return title, text.strip()
    except ImportError:
        pass
    except Exception as exc:  # a hostile page must not kill extraction — fall through to stdlib
        logger.debug("trafilatura failed, using stdlib fallback: %s", exc)
    extractor = _TextExtractor()
    try:
        extractor.feed(html_text)
    except Exception as exc:  # malformed markup mid-parse: keep what we have
        logger.debug("stdlib HTML parse stopped early: %s", exc)
    title_parser = _TitleExtractor()
    try:
        title_parser.feed(html_text[:100_000])
    except Exception:
        pass
    return title_parser.title or "", extractor.text()


def extract_page(
    url: str,
    *,
    timeout: float = DEFAULT_TIMEOUT_SECS,
    max_bytes: int = DEFAULT_MAX_BYTES,
    max_chars: int = DEFAULT_MAX_CHARS,
    max_redirects: int = DEFAULT_MAX_REDIRECTS,
    connect: Optional[Callable[..., socket.socket]] = None,
) -> dict[str, Any]:
    """One bounded extraction → legacy extract entry (``document`` or ``page_error``)."""
    try:
        final_url, _ctype, html_text = fetch_page(
            url, timeout=timeout, max_bytes=max_bytes, max_redirects=max_redirects, connect=connect
        )
        title, text = html_to_text(html_text)
        if not text.strip():
            raise ExtractError("page contained no extractable text (possibly JavaScript-rendered)")
        if len(text) > max_chars:
            text = text[:max_chars] + "\n\n[truncated by resilient extractor]"
        return document(url, title, text, source_url=final_url)
    except BlockedURL as exc:
        return page_error(url, f"Blocked: {exc}")
    except ExtractError as exc:
        return page_error(url, str(exc))
    except Exception as exc:  # never raise into the dispatcher
        logger.debug("extract failed for %s: %s", redact_url(url), exc)
        return page_error(url, f"extraction failed: {exc}")
