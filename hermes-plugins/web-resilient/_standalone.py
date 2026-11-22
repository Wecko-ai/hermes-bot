"""Standalone fallbacks for the Hermes plugin surface.

When the plugin runs inside Hermes, :mod:`agent.web_search_provider` provides
:class:`WebSearchProvider` and the config-aware :func:`get_provider_env`. When it
is imported outside Hermes (tests, doc builds), these drop-in replacements keep
every module importable with the same contract.
"""
from __future__ import annotations

import os


class WebSearchProvider:  # minimal mirror of agent.web_search_provider.WebSearchProvider
    @property
    def name(self) -> str:  # pragma: no cover - identity mirror
        raise NotImplementedError

    @property
    def display_name(self) -> str:
        return self.name

    def is_available(self) -> bool:
        raise NotImplementedError

    def supports_search(self) -> bool:
        return True

    def supports_extract(self) -> bool:
        return False

    def is_keyless_available(self) -> bool:
        return False


def get_provider_env(name: str) -> str:
    """``os.environ`` lookup, then a best-effort parse of ``$HERMES_HOME/.env`` (no secrets
    are read by this plugin beyond the named key; values are never logged)."""
    val = os.getenv(name)
    if val is None:
        val = _dotenv_value(name)
    return (val or "").strip()


def _dotenv_value(name: str) -> str:
    home = os.getenv("HERMES_HOME") or os.path.join(os.path.expanduser("~"), ".hermes")
    try:
        with open(os.path.join(home, ".env"), "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if line.startswith(f"{name}="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""
