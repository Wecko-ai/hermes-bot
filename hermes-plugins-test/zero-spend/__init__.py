"""Refuse paid model calls before provider requests when HermesBot zero-spend mode is enabled."""

from __future__ import annotations

import ipaddress
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

SETTINGS_FILE = Path.home() / ".hermes" / "hermesbot-settings.json"
AUDIT_FILE = Path.home() / ".hermes" / "zero-spend-blocks.jsonl"

LOCAL_PROVIDERS = {
    "ollama", "omlx", "lmstudio", "llamacpp", "vllm", "local",
    "custom:ollama", "custom:omlx", "custom:lmstudio", "custom:llamacpp", "custom:vllm",
}
SUBSCRIPTION_PROVIDERS = {"opencode-go", "custom:opencode-go"}
CURSOR_PROVIDERS = {"cursor", "custom:cursor", "custom"}
GEMINI_FREE = re.compile(r"flash|hydrogen")
GEMINI_PAID = re.compile(r"pro|carbon|argon|omni|ultra")


def _cursor_proxy_port() -> int | None:
    raw = os.environ.get("ZERO_SPEND_CURSOR_PROXY_PORT", "").strip()
    if not raw:
        return None
    try:
        port = int(raw)
    except ValueError:
        return None
    return port if 1 <= port <= 65535 else None


def enabled() -> bool:
    """Active only when HermesBot wrote zeroSpend: true. Missing or invalid settings keep the plugin off."""
    try:
        if not SETTINGS_FILE.is_file() or SETTINGS_FILE.stat().st_size > 256 * 1024:
            return False
        value = json.loads(SETTINGS_FILE.read_text("utf-8")).get("zeroSpend")
        if isinstance(value, bool):
            return value
        if isinstance(value, dict) and isinstance(value.get("enabled"), bool):
            return value["enabled"]
    except Exception:
        pass
    return False


def _host_path(base_url: str) -> tuple[str, str]:
    try:
        parsed = urlparse(str(base_url or ""))
        if parsed.scheme.lower() not in {"http", "https"} or parsed.username or parsed.password:
            return "", ""
        return (parsed.hostname or "").lower(), parsed.path.rstrip("/").lower()
    except Exception:
        return "", ""


def _port(base_url: str) -> int | None:
    try:
        return urlparse(str(base_url or "")).port
    except Exception:
        return None


def _loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def policy_decision(provider: str, model: str, base_url: str) -> str | None:
    """None allows the call; a short reason refuses it."""
    if not enabled():
        return None
    provider = str(provider or "").strip().lower()
    model = str(model or "").strip()
    host, path = _host_path(base_url)
    if not provider or not model or not host:
        return "unknown_route"
    if provider in LOCAL_PROVIDERS and _loopback(host):
        return None
    cursor_port = _cursor_proxy_port()
    if (cursor_port is not None and provider in CURSOR_PROVIDERS and model.lower().startswith("cursor/")
            and _loopback(host) and _port(base_url) == cursor_port):
        return None
    if provider == "kimi-coding" and host == "api.kimi.com" and path in {"/coding", "/coding/v1"}:
        return None
    if provider in SUBSCRIPTION_PROVIDERS and host == "opencode.ai" and path in {"/zen/go", "/zen/go/v1"}:
        return None
    if provider == "openrouter" and host == "openrouter.ai":
        if model.lower().endswith(":free") or model.lower() == "openrouter/free":
            return None
        return "openrouter_paid_model"
    if provider == "gemini" and host == "generativelanguage.googleapis.com":
        lowered = model.lower()
        if GEMINI_FREE.search(lowered) and not GEMINI_PAID.search(lowered):
            return None
        return "gemini_not_free"
    if provider == "nvidia" and host == "integrate.api.nvidia.com" and path == "/v1":
        return None
    return "paid_or_unverified"


def _profile() -> str:
    try:
        from hermes_constants import get_hermes_home
        home = Path(get_hermes_home())
        return "default" if home == Path.home() / ".hermes" else home.name[:80]
    except Exception:
        return "unknown"


def _audit(provider: str, model: str, base_url: str, surface: str, reason: str) -> None:
    try:
        host, _ = _host_path(base_url)
        row = {
            "at": datetime.now(timezone.utc).isoformat(),
            "profile": _profile(),
            "provider": str(provider or "")[:80],
            "model": str(model or "")[:200],
            "host": host[:120],
            "surface": str(surface or "")[:60],
            "reason": reason[:80],
        }
        AUDIT_FILE.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(AUDIT_FILE, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as stream:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _verdict(provider: str, model: str, base_url: str, surface: str) -> dict[str, str] | None:
    try:
        reason = policy_decision(provider, model, base_url)
    except Exception:
        reason = "policy_error"
    if reason is None:
        return None
    _audit(provider, model, base_url, surface, reason)
    return {
        "action": "block",
        "message": (
            f"Zero-spend policy blocked {provider or 'unknown'}/{model or 'unknown'} ({reason}). "
            "Pick a free or allowed subscription model, or turn off zero-spend mode in HermesBot."
        ),
    }


def _pre_llm_call(model: str = "", platform: str = "", **_: Any) -> dict[str, str] | None:
    if not enabled():
        return None
    try:
        from hermes_cli.runtime_provider import resolve_runtime_provider
        runtime = resolve_runtime_provider(target_model=model)
        return _verdict(runtime.get("provider", ""), model, runtime.get("base_url", ""), platform)
    except Exception:
        return _verdict("", model, "", platform)


def _pre_api_request(provider: str = "", model: str = "", base_url: str = "", platform: str = "", **_: Any) -> dict[str, str] | None:
    return _verdict(provider, model, base_url, platform)


def _pre_auxiliary_call(provider: str = "", model: str = "", base_url: str = "", aux_task: str = "", **_: Any) -> dict[str, str] | None:
    return _verdict(provider, model, base_url, f"aux:{aux_task}")


def register(ctx) -> None:
    ctx.register_hook("pre_llm_call", _pre_llm_call)
    ctx.register_hook("pre_api_request", _pre_api_request)
    ctx.register_hook("pre_auxiliary_call", _pre_auxiliary_call)