"""Resilient free web search provider plugin.

Registers a single ``WebSearchProvider`` named ``resilient`` that fails over at
runtime between a configured local SearXNG instance (``SEARXNG_URL``) and the
free ``ddgs`` package, and serves ``web_extract`` from a bounded local HTTP
fetch (Trafilatura when installed, safe stdlib HTML-to-text fallback).

Enable with ``web.search_backend: resilient`` / ``web.extract_backend: resilient``
(``web.backend: resilient`` sets both). No API key, no paid provider.
"""
from __future__ import annotations

from .provider import ResilientWebSearchProvider


def register(ctx) -> None:
    ctx.register_web_search_provider(ResilientWebSearchProvider())
