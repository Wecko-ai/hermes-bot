"""Legacy wire shapes and the Hermes-facing imports (key order is part of the contract —
the serialized JSON reaches the model). Mirrors ``plugins/web/_common.py`` without
depending on the bundled plugin package.
"""
from __future__ import annotations

from typing import Any, Optional

try:  # inside Hermes
    from agent.web_search_provider import WebSearchProvider, get_provider_env
except Exception:  # standalone (tests, docs)
    from ._standalone import WebSearchProvider, get_provider_env

__all__ = [
    "WebSearchProvider", "get_provider_env",
    "search_ok", "search_fail", "title_hit",
    "document", "page_error", "extract_fail",
]


def search_ok(web_results: list[dict[str, Any]]) -> dict[str, Any]:
    return {"success": True, "data": {"web": web_results}}


def search_fail(error: str) -> dict[str, Any]:
    return {"success": False, "error": error}


def title_hit(title: str, url: str, description: str, position: int) -> dict[str, Any]:
    """Title-first row — the historical wire shape of searxng/ddgs results."""
    return {"title": title, "url": url, "description": description, "position": position}


def document(url: str, title: str, content: str, *, source_url: Optional[str] = None) -> dict[str, Any]:
    """Successful extract entry; ``raw_content`` mirrors ``content`` for the legacy pipeline."""
    return {
        "url": url, "title": title, "content": content, "raw_content": content,
        "metadata": {"sourceURL": url if source_url is None else source_url, "title": title},
    }


def page_error(url: str, error: str) -> dict[str, Any]:
    return {"url": url, "title": "", "content": "", "error": error}


def extract_fail(urls: list[str], error: str) -> list[dict[str, Any]]:
    return [page_error(u, error) for u in urls]
