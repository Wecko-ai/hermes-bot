"""Log redaction: search queries can carry personal or secret text, so logs and
error surfaces never carry the raw query — only its length and a short hash tag
that lets an operator correlate retries without reading the query.
"""
from __future__ import annotations

import hashlib
from urllib.parse import urlsplit, urlunsplit


def query_tag(query: str) -> str:
    """``len=<n> id=<8 hex>`` — correlation without disclosure."""
    digest = hashlib.sha256(query.encode("utf-8", errors="replace")).hexdigest()[:8]
    return f"len={len(query)} id={digest}"


def redact_url(url: str) -> str:
    """URL safe for logs: query and fragment dropped (they can carry tokens)."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return "(unparseable URL)"
    if not parts.query and not parts.fragment:
        return url
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
