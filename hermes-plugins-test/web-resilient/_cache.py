"""Brief successful-result cache scoped to the active Hermes home/profile.

In-process only (never on disk): search responses keyed by
``(scope, "search", query, limit)``. Only *successful* responses are stored —
failures and empty-result fallbacks are never cached, so a rescued or broken
backend cannot go sticky for the TTL. Entries expire after a short TTL and the
cache is bounded; oldest entries are evicted first.
"""
from __future__ import annotations

import os
import threading
import time
from typing import Any, Optional

DEFAULT_TTL_SECONDS = 300.0
DEFAULT_MAX_ENTRIES = 128


def hermes_scope() -> str:
    """Cache namespace for the active Hermes home + profile (best effort, no secrets)."""
    home = os.path.abspath(os.path.expanduser(os.getenv("HERMES_HOME") or "~/.hermes"))
    profile = (os.getenv("HERMES_PROFILE") or "").strip()
    if not profile:
        try:  # config-aware lookup inside Hermes; cheap and defensive
            from hermes_cli.config import load_config_readonly

            cfg = load_config_readonly() or {}
            for key in ("profile", "active_profile"):
                val = cfg.get(key)
                if isinstance(val, str) and val.strip():
                    profile = val.strip()
                    break
        except Exception:
            profile = ""
    return f"{home}|{profile or 'default'}"


class SuccessCache:
    def __init__(self, ttl_seconds: float = DEFAULT_TTL_SECONDS, max_entries: int = DEFAULT_MAX_ENTRIES) -> None:
        self.ttl_seconds = max(1.0, float(ttl_seconds))
        self.max_entries = max(1, int(max_entries))
        self._entries: dict[tuple, tuple[float, Any]] = {}
        self._lock = threading.Lock()

    def get(self, key: tuple) -> Optional[Any]:
        now = time.monotonic()
        with self._lock:
            hit = self._entries.get(key)
            if hit is None:
                return None
            expires_at, value = hit
            if now >= expires_at:
                del self._entries[key]
                return None
            return value

    def set(self, key: tuple, value: Any) -> None:
        now = time.monotonic()
        with self._lock:
            self._entries[key] = (now + self.ttl_seconds, value)
            while len(self._entries) > self.max_entries:
                oldest = min(self._entries, key=lambda k: self._entries[k][0])
                del self._entries[oldest]

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)
