"""Geodesy helpers (stdlib only)."""

from __future__ import annotations

import math

_EARTH_RADIUS_M = 6_371_008.8


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in meters."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return 2 * _EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))


def valid_lat_lon(lat: object, lon: object) -> bool:
    try:
        lat_f, lon_f = float(lat), float(lon)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return False
    return -90.0 <= lat_f <= 90.0 and -180.0 <= lon_f <= 180.0
