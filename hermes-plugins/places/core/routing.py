"""Pedestrian routing: local Valhalla, public Valhalla, OSRM foot, haversine last.

The haversine fallback reports ``kind="straight_line"`` with no ``seconds``
field — a straight-line distance is never dressed up as a walking time.
"""

from __future__ import annotations

import json
import urllib.parse
from typing import Optional

from . import config, geo, net

MAX_ROUTE_DISTANCE_M = 100_000.0
MAX_ROUTE_SECONDS = 24 * 3600.0

_SOURCE_ATTRIBUTION = {
    "valhalla_local": config.VALHALLA_LOCAL_ATTRIBUTION,
    "valhalla": config.VALHALLA_ATTRIBUTION,
    "osrm_foot": config.OSRM_ATTRIBUTION,
}


def _sanity_check(meters: float, seconds: Optional[float]) -> bool:
    if not (0.0 < meters <= MAX_ROUTE_DISTANCE_M):
        return False
    if seconds is not None and not (0.0 < seconds <= MAX_ROUTE_SECONDS):
        return False
    return True


def _valhalla_backend(endpoint_key: str, origin: tuple[float, float], dest: tuple[float, float],
                      io: net.Io, budget: net.Budget) -> dict:
    endpoint = config.ENDPOINTS[endpoint_key]
    payload = {
        "locations": [{"lat": origin[0], "lon": origin[1]},
                      {"lat": dest[0], "lon": dest[1]}],
        "costing": "pedestrian",
        "units": "kilometers",
    }
    url = endpoint.url + "?json=" + urllib.parse.quote(json.dumps(payload, separators=(",", ":")))
    document = net.request_json(
        "GET", url, timeout_s=budget.take(endpoint.timeout_s),
        max_bytes=endpoint.max_bytes, io=io)
    if not isinstance(document, dict):
        raise net.DecodeError("valhalla: response is not an object")
    summary = document.get("trip", {}).get("summary") if isinstance(document.get("trip"), dict) else None
    if not isinstance(summary, dict):
        raise net.DecodeError("valhalla: missing trip.summary")
    meters = float(summary.get("length", 0)) * 1000.0
    seconds = float(summary.get("time", 0))
    if not _sanity_check(meters, seconds):
        raise net.DecodeError("valhalla: implausible route figures")
    return {"meters": round(meters, 1), "seconds": int(seconds),
            "kind": "route", "source": endpoint_key}


def _valhalla_local(origin: tuple[float, float], dest: tuple[float, float],
                    io: net.Io, budget: net.Budget) -> dict:
    return _valhalla_backend("valhalla_local", origin, dest, io, budget)


def _valhalla(origin: tuple[float, float], dest: tuple[float, float],
              io: net.Io, budget: net.Budget) -> dict:
    return _valhalla_backend("valhalla", origin, dest, io, budget)


def _osrm_foot(origin: tuple[float, float], dest: tuple[float, float],
               io: net.Io, budget: net.Budget) -> dict:
    endpoint = config.ENDPOINTS["osrm_foot"]
    coords = f"{origin[1]},{origin[0]};{dest[1]},{dest[0]}"
    url = f"{endpoint.url}/{coords}?overview=false"
    document = net.request_json(
        "GET", url, timeout_s=budget.take(endpoint.timeout_s),
        max_bytes=endpoint.max_bytes, io=io)
    if not isinstance(document, dict) or not str(document.get("code", "")).startswith("Ok"):
        raise net.DecodeError("osrm: route not OK")
    routes = document.get("routes")
    if not isinstance(routes, list) or not routes or not isinstance(routes[0], dict):
        raise net.DecodeError("osrm: missing routes")
    meters = float(routes[0].get("distance", 0))
    seconds = float(routes[0].get("duration", 0))
    if not _sanity_check(meters, seconds):
        raise net.DecodeError("osrm: implausible route figures")
    return {"meters": round(meters, 1), "seconds": int(seconds),
            "kind": "route", "source": "osrm_foot"}


def haversine_distance(origin: tuple[float, float], dest: tuple[float, float]) -> dict:
    return {"meters": round(geo.haversine_m(*origin, *dest), 1),
            "kind": "straight_line", "source": "haversine"}


def route(origin: tuple[float, float], dest: tuple[float, float],
          io: net.Io, budget: net.Budget) -> tuple[dict, Optional[str]]:
    """Return ``(distance_object, attribution_or_none)``.

    Falls back from Valhalla to OSRM to straight-line haversine; the straight-line
    case is flagged by the caller through the returned attribution being None.
    """
    last_error: Optional[Exception] = None
    for backend in (_valhalla_local, _valhalla, _osrm_foot):
        if budget.exhausted():
            break
        try:
            return backend(origin, dest, io, budget), _SOURCE_ATTRIBUTION[backend.__name__.strip("_")]
        except net.NetError as exc:
            last_error = exc
            continue
    distance = haversine_distance(origin, dest)
    return distance, None


def routing_attribution_for(distance: dict) -> Optional[str]:
    return _SOURCE_ATTRIBUTION.get(str(distance.get("source", "")))
