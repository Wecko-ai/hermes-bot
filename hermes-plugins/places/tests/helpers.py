"""Shared fakes for the offline test suite."""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Make the `places` package importable when tests run from anywhere.
_PLUGIN_ROOT = Path(__file__).resolve().parents[2]  # hermes-plugins/
if str(_PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_ROOT))

from places.core import net, sanitize  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures"

# Fixed "now" for a test run: real current time so cache entries are fresh,
# while every assertion within one run compares against the same value.
NOW = sanitize.iso_now()


class FakeClock:
    """Monotonic fake clock; each call advances by ``step``."""

    def __init__(self, step: float = 0.0):
        self.t = 0.0
        self.step = step

    def __call__(self) -> float:
        self.t += self.step
        return self.t


class FakeNet:
    """Injectable ``opener`` with canned, per-endpoint responses.

    responders: dict endpoint_key -> bytes | Exception | callable(request, timeout) -> bytes
    """

    def __init__(self, responders: dict | None = None, clock: FakeClock | None = None):
        self.responders = responders or {}
        self.calls: list[str] = []
        self.clock = clock or FakeClock()

    def opener(self, request, timeout: float) -> bytes:
        url = request.full_url
        self.calls.append(url)
        for key, endpoint in net.config.ENDPOINTS.items():
            if url.startswith(endpoint.url):
                responder = self.responders.get(key)
                if responder is None:
                    raise net.NetError(f"no canned responder for {key}")
                if isinstance(responder, Exception):
                    raise responder
                if callable(responder):
                    return responder(request, timeout)
                return bytes(responder)
        raise AssertionError(f"request to non-allowlisted URL: {url}")

    def io(self, now: str = NOW) -> net.Io:
        return net.Io(opener=self.opener, clock=self.clock, now_iso=lambda: now)


def load_fixture(name: str):
    return (FIXTURES / name).read_bytes()


def load_fixture_json(name: str):
    return json.loads(load_fixture(name).decode("utf-8"))


def overpass_responder(fixture: str):
    return load_fixture(fixture)


def valhalla_ok(length_km: float = 0.062, time_s: int = 45):
    return json.dumps({"trip": {"summary": {"length": length_km, "time": time_s}}}).encode()


def osrm_ok(distance_m: float = 63.4, duration_s: float = 46.0):
    return json.dumps({"code": "Ok", "routes": [{"distance": distance_m, "duration": duration_s}]}).encode()


class FakeCtx:
    """Records ctx.register_tool calls like the Hermes PluginContext would."""

    def __init__(self, profile: str = "testprofile"):
        self.profile_name = profile
        self.registered: dict[str, dict] = {}

    def register_tool(self, name, toolset, schema, handler, **kwargs):
        self.registered[name] = {"toolset": toolset, "schema": schema,
                                 "handler": handler, "kwargs": kwargs}
