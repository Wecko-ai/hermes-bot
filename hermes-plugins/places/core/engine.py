"""Orchestration: search → dedupe → rank → route → shared contract.

Provider selection is local-first: when a local Overture extract is
configured and holds at least ``limit`` distinct candidates, it is served
straight away with zero provider network calls.  Otherwise Overpass is
queried and the local candidates are merged in (dedupe drops the overlaps);
when Overpass is down the partial local extract is still served, flagged as
incomplete.  Without a configured extract the behavior is unchanged:
Overpass → Overture fallback → last-good cache.

Determinism guarantees (same inputs + same provider data ⇒ same output):

- dedupe and ranking never depend on provider response order beyond the
  documented tie-break chain (distance, normalized name, source id),
- all warnings/attributions are appended in a fixed order.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from . import cache as cache_mod
from . import config, contract, geo, net, overpass, overture, routing, sanitize

SOURCE_PRIORITY = {"osm": 0, "overture": 1}  # lower wins on dedupe ties

_DEDUPE_NAME_RADIUS_M = 75.0


class SearchParams:
    def __init__(self, category: str, lat: float, lon: float, radius_m: float,
                 limit: int, filters: Optional[dict] = None):
        self.category = str(category).strip().lower()
        self.lat = float(lat)
        self.lon = float(lon)
        self.radius_m = float(radius_m)
        self.limit = min(max(1, int(limit)), config.RESULT_LIMIT_CAP)
        self.filters = dict(filters or {})


def validate_params(params: SearchParams) -> list[str]:
    """Return bounded validation warnings; raise ValueError on hard errors."""
    if params.category not in config.CATEGORIES:
        raise ValueError(
            f"unknown category {params.category!r}; supported: {', '.join(sorted(config.CATEGORIES))}")
    if not geo.valid_lat_lon(params.lat, params.lon):
        raise ValueError("latitude/longitude out of range")
    warnings = []
    if not (config.RADIUS_MIN_M <= params.radius_m <= config.RADIUS_MAX_M):
        warnings.append(
            f"radius clamped to [{config.RADIUS_MIN_M:.0f}, {config.RADIUS_MAX_M:.0f}] m")
        params.radius_m = min(max(params.radius_m, config.RADIUS_MIN_M), config.RADIUS_MAX_M)
    return warnings


def _apply_filters(pois: list[dict], filters: dict) -> tuple[list[dict], list[str]]:
    """Best-effort client filters; unknown filters are ignored with a warning."""
    warnings: list[str] = []
    out = pois
    name_contains = filters.get("name_contains")
    if name_contains is not None:
        needle = sanitize.normalize_name(str(name_contains))
        if needle:
            out = [p for p in out if needle in sanitize.normalize_name(p.get("name", ""))]
    wheelchair = filters.get("wheelchair")
    if wheelchair is not None:
        kept = []
        for p in out:
            tag = str((p.get("tags") or {}).get("wheelchair", "")).lower()
            if bool(wheelchair) and tag == "yes":
                kept.append(p)
            elif not bool(wheelchair) and tag in {"no", "limited"}:
                kept.append(p)
            # unknown accessibility confirms neither filter: dropped
        out = kept
    open_now = filters.get("open_now")
    if open_now is not None:
        warnings.append("open_now filter ignored: opening hours are not sourced by this plugin")
    for key in filters:
        if key not in {"name_contains", "wheelchair", "open_now"}:
            warnings.append(f"unknown filter {key!r} ignored")
    return out, warnings


def _record_score(poi: dict) -> tuple[int, int]:
    filled = sum(1 for k in ("address", "features") if poi.get(k))
    return (filled, -SOURCE_PRIORITY.get(str(poi["source_id"]).split(":", 1)[0], 9))


def dedupe(pois: list[dict]) -> list[dict]:
    """Drop duplicates: exact source id first, then normalized name + proximity."""
    by_id: dict[str, dict] = {}
    for poi in pois:
        sid = str(poi.get("source_id", ""))
        existing = by_id.get(sid)
        if existing is None or _record_score(poi) > _record_score(existing):
            by_id[sid] = poi
    unique = list(by_id.values())

    merged: list[dict] = []
    for poi in sorted(unique, key=lambda p: (sanitize.normalize_name(p.get("name", "")),
                                             str(p.get("source_id", "")))):
        name_key = sanitize.normalize_name(poi.get("name", ""))
        duplicate_of: Optional[dict] = None
        for kept in merged:
            if sanitize.normalize_name(kept.get("name", "")) != name_key:
                continue
            if geo.haversine_m(kept["lat"], kept["lon"], poi["lat"], poi["lon"]) <= _DEDUPE_NAME_RADIUS_M:
                duplicate_of = kept
                break
        if duplicate_of is None:
            merged.append(poi)
        elif _record_score(poi) > _record_score(duplicate_of):
            merged[merged.index(duplicate_of)] = poi
    return merged


def rank(pois: list[dict], origin: tuple[float, float]) -> list[dict]:
    """Deterministic ranking by straight-line distance, then name, then id."""
    keyed = []
    for poi in pois:
        d = geo.haversine_m(*origin, poi["lat"], poi["lon"])
        keyed.append((round(d, 1),
                      sanitize.normalize_name(poi.get("name", "")),
                      str(poi.get("source_id", "")),
                      poi))
    keyed.sort(key=lambda item: item[:3])
    return [item[3] for item in keyed]


def _overture_source_name(poi: dict) -> str:
    """Verifiable per-place attribution: dataset names when the extract
    records them (``Overture Maps (Foursquare, Meta)``), plain ``Overture
    Maps`` otherwise.  Never exceeds the contract's 80-char source.name cap;
    entries that would overflow are dropped from the tail."""
    sources = poi.get("sources")
    if not sources:
        return "Overture Maps"
    display = [s[:1].upper() + s[1:] for s in sources]
    name = "Overture Maps"
    for take in range(len(display), 0, -1):
        candidate = "Overture Maps (" + ", ".join(display[:take]) + ")"
        if len(candidate) <= 80:
            name = candidate
            break
    return name


def _source_block(poi: dict, fetched_at: str) -> dict:
    source_id = str(poi["source_id"])
    if source_id.startswith("osm:"):
        rest = source_id[4:]
        osm_type = rest.split("/", 1)[0]
        url = f"https://www.openstreetmap.org/{rest}"
        if osm_type not in {"node", "way", "relation"}:
            url = None
        name = "OpenStreetMap"
    elif source_id.startswith("overture:"):
        url = "https://overturemaps.org"
        name = _overture_source_name(poi)
    else:
        url = None
        name = "OpenStreetMap" if source_id.startswith("osm:") else "Overture Maps"
    block = {"name": name, "fetched_at": fetched_at}
    if url:
        block["url"] = url
    return block


def search_places(params: SearchParams, io: net.Io,
                  cache: Optional[cache_mod.LastGoodCache] = None,
                  adapter: Optional[object] = None) -> dict:
    """Full pipeline.  Returns the contract document dict (validate with
    :func:`contract.validate_contract`).  Raises :class:`LookupError` when no
    place at all could be found (caller turns that into a plain-text reply).

    With a configured, available Overture adapter the local extract is served
    first when it alone can satisfy ``limit``; otherwise Overpass completes
    it, then the last-good cache still backs everything up."""
    warnings = validate_params(params)
    origin = (params.lat, params.lon)
    budget = net.Budget(clock=io.clock)

    pois: Optional[list[dict]] = None
    fetched_at = io.now_iso()
    attributions: list[str] = []
    from_cache = False
    cached_fetched_at: Optional[str] = None

    # --- local Overture extract, local-first --------------------------------
    # Prefetch is a local-file scan (no network).  It runs before Overpass so
    # that a self-sufficient extract is served without any provider call —
    # two dead Overpass mirrors cost ~24 s, an extract costs milliseconds.
    local_pois: Optional[list[dict]] = None
    local_fetched_at = fetched_at
    local_error: Optional[str] = None
    if adapter is not None:
        try:
            available, reason = adapter.available()
            if not available:
                local_error = reason
            else:
                local_pois, local_fetched_at = adapter.search(
                    params.category, params.lat, params.lon, params.radius_m, io.now_iso())
        except Exception as exc:  # a broken extract must never break a lookup
            local_error = type(exc).__name__
            local_pois = None
    local_distinct = len(dedupe(local_pois)) if local_pois else 0

    if local_pois is not None and local_distinct >= params.limit:
        pois = local_pois
        fetched_at = local_fetched_at
        attributions.append(config.OVERTURE_ATTRIBUTION)
        warnings.append("results come from a local Overture extract; "
                        "coverage may be limited")
    else:
        try:
            pois, fetched_at = overpass.search(
                params.category, params.lat, params.lon, params.radius_m, io, budget)
            attributions.append(config.OSM_ATTRIBUTION)
            if cache is not None:
                warn = cache.store(params.category, params.lat, params.lon, params.radius_m,
                                   pois, fetched_at)
                if warn:
                    warnings.append(warn)
            if local_pois:
                # the mirrors may know places the extract misses: merge, dedupe decides
                pois = pois + local_pois
                attributions.append(config.OVERTURE_ATTRIBUTION)
                warnings.append("local Overture extract candidates merged with the "
                                "Overpass results")
        except overpass.OverpassError as exc:
            warnings.append(f"live OpenStreetMap lookup failed ({sanitize.clean_text(exc, 120)}); "
                            "trying Overture fallback")
            if local_pois:
                pois = local_pois
                fetched_at = local_fetched_at
                attributions.append(config.OVERTURE_ATTRIBUTION)
                warnings.append("results come from a local Overture extract; "
                                "coverage may be limited")
                if local_distinct < params.limit:
                    warnings.append(
                        f"local extract holds only {local_distinct} distinct "
                        f"{params.category} within range (limit {params.limit}); "
                        "results are incomplete")
            elif local_error is not None:
                warnings.append(f"overture fallback unavailable: "
                                f"{sanitize.clean_text(local_error, 120)}")

    if pois is None and cache is not None:
        cached = cache.fetch(params.category, params.lat, params.lon, params.radius_m)
        if cached is not None:
            pois, cached_fetched_at, stale = cached
            from_cache = True
            attributions.append(config.OSM_ATTRIBUTION)
            age = sanitize.iso_age_seconds(cached_fetched_at)
            age_txt = "unknown age" if age is None else f"{int(age // 3600)}h old"
            warnings.append(f"served from the last-good cache ({age_txt}"
                            f"{', stale' if stale else ''}); live lookup failed")

    if pois is None:
        raise LookupError("all place providers failed and no cached result is available")

    if from_cache:
        fetched_at = cached_fetched_at or fetched_at

    pois, filter_warnings = _apply_filters(pois, params.filters)
    warnings.extend(filter_warnings)
    pois = dedupe(pois)
    pois = rank(pois, origin)[: params.limit * 2]  # fetch a little extra before routing wins

    places: list[dict] = []
    route_attribution: Optional[str] = None
    for poi in pois:
        if len(places) >= params.limit:
            break
        if budget.exhausted():
            warnings.append("time budget exhausted; distances are straight-line estimates")
            distance = routing.haversine_distance(origin, (poi["lat"], poi["lon"]))
        else:
            distance, attribution = routing.route(origin, (poi["lat"], poi["lon"]), io, budget)
            if attribution is None:
                warnings.append("walking route unavailable; distance is a straight-line estimate")
            elif route_attribution is None:
                route_attribution = attribution
        place = {
            "id": str(poi["source_id"])[:120],
            "name": sanitize.clean_text(poi["name"], 200),
            "latitude": round(float(poi["lat"]), 6),
            "longitude": round(float(poi["lon"]), 6),
            "category": sanitize.clean_text(poi["category"], 60),
            # destination only: no origin in the link, so the phone uses its
            # own GPS fix and the caller's position is not leaked
            "directions_url": contract.google_maps_walking_url(
                float(poi["lat"]), float(poi["lon"])),
            "source": _source_block(poi, fetched_at),
            "distance": distance,
        }
        if poi.get("address"):
            place["address"] = sanitize.clean_text(poi["address"], 300)
        if poi.get("features"):
            place["features"] = poi["features"]
        places.append(place)

    if not places:
        raise LookupError("no places matched the request")

    # fixed attribution order: data, routing, directions links
    if route_attribution:
        attributions.append(route_attribution)
    attributions.append(config.GOOGLE_MAPS_ATTRIBUTION)

    document = {
        "version": config.CONTRACT_VERSION,
        "generated_at": io.now_iso(),
        "attributions": attributions,
        "warnings": warnings,
        "places": places,
    }
    contract.validate_contract(document)
    return document


def resolve_home() -> Path:
    """Active Hermes home: context-local/env resolution only — never a hardcoded
    ``~/.hermes`` (a different profile must get its own cache)."""
    try:
        from hermes_constants import get_hermes_home  # type: ignore

        return Path(get_hermes_home())
    except Exception:
        import os

        env_home = os.environ.get("HERMES_HOME", "").strip()
        if env_home:
            return Path(env_home).expanduser()
        raise LookupError(
            "cannot resolve the active Hermes home (hermes_constants unavailable and "
            "HERMES_HOME unset); refusing to guess a cache location")
