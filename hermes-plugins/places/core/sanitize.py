"""Defensive handling of text that comes from the network.

All web/review/provider text is treated as hostile *data*: it is only ever
cleaned, truncated and re-serialized as JSON.  It is never interpreted,
executed, rendered as markup or used to build instructions.
"""

from __future__ import annotations

import re
import unicodedata

_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_WS_RE = re.compile(r"\s+")


def clean_text(value: object, max_len: int) -> str:
    """Coerce ``value`` to a bounded single-line-ish string safe to embed in JSON.

    - drops C0 control characters (keeps tab/newline, collapsed to spaces),
    - strips Unicode category Cc/Cf noise such as bidi overrides,
    - truncates by code points, never splits below the limit silently.
    """
    if value is None:
        return ""
    text = str(value)
    text = _CONTROL_RE.sub(" ", text)
    # Drop format characters (zero-width, bidi controls) — they are never
    # legitimate content and can spoof rendering downstream.
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Cf")
    text = _WS_RE.sub(" ", text).strip()
    if len(text) > max_len:
        text = text[: max_len - 1].rstrip() + "…"
    return text


def bounded_str(value: object, max_len: int) -> str | None:
    """``clean_text`` returning None for empty input (for optional fields)."""
    text = clean_text(value, max_len)
    return text or None


def _fold_char(ch: str) -> str:
    """Accent-fold one character, but only when it decomposes to plain ASCII.

    ``é`` → ``e``; Japanese kana like ``だ`` (decomposes to た + dakuten) are
    left untouched so non-Latin names survive dedupe normalization intact.
    """
    decomp = unicodedata.normalize("NFKD", ch)
    if decomp != ch and decomp and all(
        (c.isascii() and c.isalpha()) or unicodedata.category(c).startswith("M")
        for c in decomp
    ):
        return "".join(c for c in decomp if not unicodedata.category(c).startswith("M"))
    return ch


def normalize_name(name: str) -> str:
    """Normalization key for dedupe: accent-folded, lowercase, alnum only.

    Works across scripts (Latin accents fold, Japanese kana/kanji pass through
    as their own code points), so identical venue names collide in any language.
    """
    return "".join(ch for ch in map(_fold_char, str(name).lower()) if ch.isalnum())


def iso_now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_iso(value: str):
    from datetime import datetime, timezone

    text = str(value).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def iso_age_seconds(value: str, now_iso: str | None = None) -> float | None:
    """Age of an ISO-8601 timestamp in seconds, or None when unparseable."""
    dt = parse_iso(value)
    if dt is None:
        return None
    now = parse_iso(now_iso) if now_iso else None
    if now is None:
        from datetime import datetime, timezone

        now = datetime.now(timezone.utc)
    return max(0.0, (now - dt).total_seconds())
