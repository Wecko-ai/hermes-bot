"""Hermes-facing tools: ``places_nearby`` and ``places_doctor``.

Tool handlers follow the Hermes plugin contract ``handler(args, **kwargs) ->
str`` and are thin wrappers around :mod:`places.core`, which is pure stdlib
and fully testable without Hermes or the network.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

from .core import cache as cache_mod
from .core import config, contract, engine, net, overture, sanitize

SCHEMAS: dict[str, dict] = {
    "places_nearby": {
        "name": "places_nearby",
        "description": (
            "Find up to 3 real places near a location (cafes, pharmacies, parks, ...) from "
            "OpenStreetMap with an Overture fallback, pedestrian walking distance and Google "
            "Maps walking directions. Returns a fenced ```hermes-places JSON block."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "category": {
                    "type": "string",
                    "description": "Place category, e.g. cafe, restaurant, pharmacy, supermarket, park.",
                    "enum": sorted(config.CATEGORIES),
                },
                "latitude": {"type": "number", "minimum": -90, "maximum": 90},
                "longitude": {"type": "number", "minimum": -180, "maximum": 180},
                "radius": {
                    "type": "number",
                    "description": f"Search radius in meters ({config.RADIUS_MIN_M:.0f}–{config.RADIUS_MAX_M:.0f}, default {config.RADIUS_DEFAULT_M:.0f}).",
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum number of places (capped at 3).",
                    "minimum": 1,
                    "maximum": config.RESULT_LIMIT_CAP,
                },
                "filters": {
                    "type": "object",
                    "description": "Optional filters: name_contains (string), wheelchair (boolean).",
                    "properties": {
                        "name_contains": {"type": "string"},
                        "wheelchair": {"type": "boolean"},
                    },
                    "additionalProperties": False,
                },
            },
            "required": ["category", "latitude", "longitude"],
        },
    },
    "places_doctor": {
        "name": "places_doctor",
        "description": (
            "Diagnostics for the places plugin: endpoint allowlist integrity, Hermes home and "
            "cache state, Overture fallback configuration, and optional short live probes of "
            "Overpass plus the local and public Valhalla routing endpoints (degraded status "
            "when only public routing answers)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "probe": {
                    "type": "boolean",
                    "description": "Also run short live network probes (default false, works offline without it).",
                },
            },
        },
    },
}


# --- runtime plumbing ---------------------------------------------------------

class Runtime:
    """Per-call resources bound to the active Hermes home/profile."""

    def __init__(self, profile: str, io: Optional[net.Io] = None):
        self.profile = profile
        self.io = io or net.Io()
        self._home: Optional[Path] = None
        self._settings: Optional[dict] = None
        self._settings_error: Optional[str] = None

    @property
    def home(self) -> Path:
        if self._home is None:
            self._home = engine.resolve_home()
        return self._home

    @property
    def cache(self) -> cache_mod.LastGoodCache:
        return cache_mod.LastGoodCache(self.home, self.profile)

    def settings(self) -> tuple[dict, Optional[str]]:
        """Optional operator settings from <home>/places/config.json."""
        if self._settings is not None or self._settings_error is not None:
            return self._settings or {}, self._settings_error
        path = self.home / "places" / "config.json"
        if not path.is_file():
            self._settings = {}
            return self._settings, None
        try:
            raw = path.read_bytes()
            if len(raw) > 16_384:
                raise ValueError("settings file exceeds 16 KB cap")
            data = json.loads(raw.decode("utf-8"))
            if not isinstance(data, dict):
                raise ValueError("settings file must be a JSON object")
        except (OSError, UnicodeDecodeError, ValueError) as exc:
            self._settings_error = f"invalid places config: {type(exc).__name__}"
            self._settings = {}
            return self._settings, self._settings_error
        clean: dict = {}
        for key in ("overture_jsonl", "overture_geoparquet"):
            value = data.get(key)
            if value is None:
                continue
            candidate = Path(str(value)).expanduser()
            if not candidate.is_absolute():
                self._settings_error = f"{key} must be an absolute path"
                continue
            suffix = candidate.suffix.lower()
            if key == "overture_jsonl" and suffix not in {".jsonl", ".ndjson", ".json"}:
                self._settings_error = f"{key} must point to a .jsonl extract"
                continue
            if key == "overture_geoparquet" and suffix != ".parquet":
                self._settings_error = f"{key} must point to a .parquet file"
                continue
            clean[key] = str(candidate)
        self._settings = clean
        return self._settings, self._settings_error

    def adapter(self):
        settings, _ = self.settings()
        try:
            return overture.adapter_from_config(settings)
        except Exception:
            return None


def _make_runtime(profile: str) -> Runtime:
    return Runtime(profile)


# --- handlers -------------------------------------------------------------------

def handle_places_nearby(args: dict, *, _runtime: Optional[Runtime] = None, **_kw) -> str:
    runtime = _runtime or _make_runtime(_profile_of(_kw))
    try:
        runtime.home  # fail early with a clear error when the home is unresolvable
    except LookupError as exc:
        return f"Error: {sanitize.clean_text(exc, 200)}"
    try:
        category = args.get("category")
        lat, lon = args.get("latitude"), args.get("longitude")
        if category is None or lat is None or lon is None:
            return "Error: category, latitude and longitude are required."
        params = engine.SearchParams(
            category=category,
            lat=lat,
            lon=lon,
            radius_m=args.get("radius", config.RADIUS_DEFAULT_M),
            limit=args.get("limit", config.RESULT_LIMIT_CAP),
            filters=args.get("filters") or {},
        )
        document = engine.search_places(params, runtime.io, cache=runtime.cache,
                                        adapter=runtime.adapter())
        return contract.render(document)
    except ValueError as exc:
        return f"Error: {sanitize.clean_text(exc, 200)}"
    except LookupError as exc:
        return (f"No places found: {sanitize.clean_text(exc, 200)}. "
                "Try a larger radius or another category.")
    except Exception as exc:  # defensive: never leak internals beyond type name
        return f"Error: places lookup failed ({type(exc).__name__})"


def handle_places_doctor(args: dict, *, _runtime: Optional[Runtime] = None, **_kw) -> str:
    runtime = _runtime or _make_runtime(_profile_of(_kw))
    report: dict[str, Any] = {"plugin": config.PLUGIN_NAME, "ok": True, "checks": []}

    def add(name: str, ok: bool, detail: str) -> None:
        report["checks"].append({"check": name, "ok": bool(ok), "detail": sanitize.clean_text(detail, 300)})
        if not ok:
            report["ok"] = False

    allowlist_problems = config.validate_allowlist()
    add("endpoint_allowlist", not allowlist_problems,
        "; ".join(allowlist_problems) if allowlist_problems else
        f"{len(config.ENDPOINTS)} HTTPS endpoints, no embedded credentials")

    try:
        home = runtime.home
        add("hermes_home", True, f"resolved active home for profile {runtime.profile!r}")
    except LookupError as exc:
        add("hermes_home", False, sanitize.clean_text(exc, 200))
        home = None

    if home is not None:
        try:
            info = runtime.cache.describe()
            add("cache", True,
                f"{info['entries']} cached grid(s), file {info['path']}")
        except Exception as exc:
            add("cache", False, type(exc).__name__)

        settings, settings_error = runtime.settings()
        if settings_error:
            add("settings", False, settings_error)
        else:
            configured = [k for k in ("overture_jsonl", "overture_geoparquet") if settings.get(k)]
            add("settings", True,
                f"config OK; Overture fallback: {', '.join(configured) if configured else 'not configured'}")

        adapter = runtime.adapter()
        if adapter is None:
            add("overture_adapter", True, "no local extract configured; fallback stays disabled")
        else:
            try:
                ok, reason = adapter.available()
                add("overture_adapter", ok, reason)
            except Exception as exc:
                add("overture_adapter", False, type(exc).__name__)

    if bool(args.get("probe")):
        probe = _live_probe(runtime)
        add("live_probe", probe["ok"], probe["detail"])
        if probe["local_valhalla_ok"] is not None:
            # degraded, not broken: routing falls back to public providers
            report["checks"].append({
                "check": "local_valhalla",
                "ok": probe["local_valhalla_ok"],
                "detail": probe["local_valhalla_detail"],
            })
        if probe["degraded"]:
            report["degraded"] = True

    return "```json\n" + json.dumps(report, ensure_ascii=False, indent=2) + "\n```"


# Fixed sample points for the doctor probes; the doctor never takes caller
# coordinates. The local Valhalla graph only covers Osaka, so its probe must
# stay inside Tennoji — any point outside the extract would fail on a healthy
# service. The public Valhalla demo covers the world and keeps the Paris pair.
_PROBE_LOCAL_A = (34.6473, 135.5139)   # Tennoji, local graph only
_PROBE_LOCAL_B = (34.6458, 135.5130)
_PROBE_PUBLIC_A = (48.8566, 2.3522)    # Paris, public demo endpoint
_PROBE_PUBLIC_B = (48.8570, 2.3530)


def _live_probe(runtime: Runtime) -> dict:
    """Short bounded probes of one Overpass mirror and both Valhalla endpoints.

    Only fixed sample points are used and nothing sensitive is logged.  A
    silent *local* Valhalla is a degraded status, not a failure: routing still
    works through the public providers.
    """
    from .core import overpass as overpass_mod
    from .core import routing as routing_mod

    io, budget = runtime.io, net.Budget(total_s=10.0, clock=runtime.io.clock)
    problems: list[str] = []
    degraded: list[str] = []
    local_ok: Optional[bool] = None
    local_detail: Optional[str] = None

    try:
        overpass_mod.parse_elements(
            net.request_json(
                "POST", config.ENDPOINTS[config.OVERPASS_MIRROR_KEYS[0]].url,
                body=b"data=%5Bout%3Ajson%5D%5Btimeout%3A5%5D%3Bnode%281%29%3Bout%201%3B",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                timeout_s=budget.take(config.DOCTOR_PROBE_TIMEOUT_S),
                max_bytes=config.ENDPOINTS[config.OVERPASS_MIRROR_KEYS[0]].max_bytes,
                io=io),
            "cafe")
    except net.NetError as exc:
        problems.append(f"overpass: {sanitize.clean_text(exc, 100)}")

    try:
        routing_mod._valhalla_local(_PROBE_LOCAL_A, _PROBE_LOCAL_B, io, budget)
        local_ok = True
        local_detail = "local Valhalla on 127.0.0.1 answered within probe budget"
    except net.NetError as exc:
        local_ok = False
        local_detail = (f"{sanitize.clean_text(exc, 100)}; routing falls back to public "
                        f"Valhalla/OSRM (slower, degraded)")
        degraded.append("local Valhalla silent")
    try:
        routing_mod._valhalla(_PROBE_PUBLIC_A, _PROBE_PUBLIC_B, io, budget)
        public_ok = True
    except net.NetError as exc:
        public_ok = False
        problems.append(f"public valhalla: {sanitize.clean_text(exc, 100)}")
    if not (local_ok or public_ok):
        problems.append("routing: no Valhalla endpoint answered (local and public)")

    if problems:
        detail = "; ".join(problems)
        if degraded:
            detail += " | degraded: " + "; ".join(degraded)
        return {"ok": False, "detail": detail, "degraded": bool(degraded),
                "local_valhalla_ok": local_ok, "local_valhalla_detail": local_detail}
    if degraded:
        return {"ok": True,
                "detail": "overpass and public valhalla responded within probe budget | "
                          "degraded: " + "; ".join(degraded)
                          + " (pedestrian routing falls back to public providers)",
                "degraded": True,
                "local_valhalla_ok": local_ok, "local_valhalla_detail": local_detail}
    return {"ok": True,
            "detail": "overpass and Valhalla (local + public) responded within probe budget",
            "degraded": False,
            "local_valhalla_ok": local_ok, "local_valhalla_detail": local_detail}


def _profile_of(kwargs: dict) -> str:
    ctx = kwargs.get("ctx") or kwargs.get("context")
    if ctx is not None:
        try:
            return str(getattr(ctx, "profile_name", "default")) or "default"
        except Exception:
            pass
    return "default"


def register_tools(ctx) -> None:
    """Register both tools in the ``places`` toolset (Hermes plugin contract)."""
    profile = "default"
    try:
        profile = str(getattr(ctx, "profile_name", "default")) or "default"
    except Exception:
        pass
    ctx.register_tool(
        name="places_nearby", toolset="places",
        schema=SCHEMAS["places_nearby"],
        handler=lambda args, **kw: handle_places_nearby(args, _runtime=_make_runtime(profile), **kw),
        description=SCHEMAS["places_nearby"]["description"], emoji="📍")
    ctx.register_tool(
        name="places_doctor", toolset="places",
        schema=SCHEMAS["places_doctor"],
        handler=lambda args, **kw: handle_places_doctor(args, _runtime=_make_runtime(profile), **kw),
        description=SCHEMAS["places_doctor"]["description"], emoji="🩺")
