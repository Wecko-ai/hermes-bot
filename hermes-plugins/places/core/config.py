"""Static configuration for the places plugin.

Security invariants encoded here:

- Every remote endpoint is an HTTPS entry in ``ENDPOINTS``.  Requests are only
  ever made through :func:`places.core.net.request`, which refuses any URL that
  is not byte-identical to an allowlisted endpoint.  There is deliberately no
  env/config override for endpoints: plugins must not fetch from arbitrary or
  operator-injected model URLs.
- All network and payload caps are bounded constants, not caller input.
- No secrets are read anywhere in this plugin.
"""

from __future__ import annotations

from dataclasses import dataclass

PLUGIN_NAME = "places"
CONTRACT_VERSION = 1
RESULT_LIMIT_CAP = 3  # shared contract: at most 3 places
MAX_PLACES_RETURNED = RESULT_LIMIT_CAP

# --- coordinate / radius bounds -------------------------------------------------
LAT_MIN, LAT_MAX = -90.0, 90.0
LON_MIN, LON_MAX = -180.0, 180.0
RADIUS_DEFAULT_M = 400.0
RADIUS_MIN_M = 50.0
RADIUS_MAX_M = 2000.0

# --- network caps ----------------------------------------------------------------
OVERPASS_TIMEOUT_S = 6.0          # per attempt
OVERPASS_ATTEMPTS = 2             # per mirror (initial + one retry)
OVERPASS_MAX_BYTES = 1_500_000    # response body cap
ROUTING_TIMEOUT_S = 4.0
ROUTING_MAX_BYTES = 256_000
DOCTOR_PROBE_TIMEOUT_S = 3.0
TOTAL_BUDGET_S = 28.0             # whole places_nearby call, enforced via core.net.Budget

# --- cache -----------------------------------------------------------------------
CACHE_TTL_S = 7 * 24 * 3600       # last-good entries older than this are "stale"
CACHE_MAX_BYTES = 5_000_000
CACHE_FILE_MODE = 0o600

# --- category mapping --------------------------------------------------------------
# OSM: list of (key, value) tag pairs.  Overture: primary category strings.
CATEGORIES: dict[str, dict] = {
    "cafe": {"osm": [("amenity", "cafe")], "overture": ["cafe"]},
    "restaurant": {"osm": [("amenity", "restaurant")], "overture": ["restaurant"]},
    "bar": {"osm": [("amenity", "bar")], "overture": ["bar", "nightclub"]},
    "bakery": {"osm": [("shop", "bakery")], "overture": ["bakery"]},
    "pharmacy": {"osm": [("amenity", "pharmacy")], "overture": ["pharmacy"]},
    "supermarket": {"osm": [("shop", "supermarket")], "overture": ["supermarket", "grocery_store"]},
    "convenience_store": {"osm": [("shop", "convenience")], "overture": ["convenience_store"]},
    "atm": {"osm": [("amenity", "atm")], "overture": ["atm"]},
    "bank": {"osm": [("amenity", "bank")], "overture": ["bank"]},
    "hospital": {"osm": [("amenity", "hospital")], "overture": ["hospital"]},
    "clinic": {"osm": [("amenity", "clinic"), ("amenity", "doctors")], "overture": ["clinic", "doctor"]},
    "park": {"osm": [("leisure", "park")], "overture": ["park"]},
    "hotel": {"osm": [("tourism", "hotel")], "overture": ["hotel", "motel"]},
    "library": {"osm": [("amenity", "library")], "overture": ["library"]},
    "museum": {"osm": [("tourism", "museum")], "overture": ["museum"]},
    "fuel": {"osm": [("amenity", "fuel")], "overture": ["fuel"]},
    "gym": {"osm": [("leisure", "fitness_centre")], "overture": ["fitness_center", "gym"]},
}


@dataclass(frozen=True)
class Endpoint:
    """One allowlisted HTTPS provider endpoint."""

    key: str
    method: str
    url: str
    timeout_s: float
    max_bytes: int


ENDPOINTS: dict[str, Endpoint] = {
    "overpass_de": Endpoint(
        key="overpass_de", method="POST",
        url="https://overpass-api.de/api/interpreter",
        timeout_s=OVERPASS_TIMEOUT_S, max_bytes=OVERPASS_MAX_BYTES),
    "overpass_kumi": Endpoint(
        key="overpass_kumi", method="POST",
        url="https://overpass.kumi.systems/api/interpreter",
        timeout_s=OVERPASS_TIMEOUT_S, max_bytes=OVERPASS_MAX_BYTES),
    "valhalla_local": Endpoint(
        key="valhalla_local", method="GET",
        url="http://127.0.0.1:8002/route",
        timeout_s=0.8, max_bytes=ROUTING_MAX_BYTES),
    "valhalla": Endpoint(
        key="valhalla", method="GET",
        url="https://valhalla1.openstreetmap.de/route",
        timeout_s=ROUTING_TIMEOUT_S, max_bytes=ROUTING_MAX_BYTES),
    "osrm_foot": Endpoint(
        key="osrm_foot", method="GET",
        url="https://routing.openstreetmap.de/routed-foot/route/v1/foot",
        timeout_s=ROUTING_TIMEOUT_S, max_bytes=ROUTING_MAX_BYTES),
}

# Overpass mirrors in failover order.
OVERPASS_MIRROR_KEYS = ("overpass_de", "overpass_kumi")

OSM_ATTRIBUTION = "© OpenStreetMap contributors (ODbL, https://www.openstreetmap.org/copyright)"
OVERTURE_ATTRIBUTION = "Overture Maps Foundation and per-record sources (CDLA-Permissive-2.0 / Apache-2.0, https://docs.overturemaps.org/attribution/)"
VALHALLA_LOCAL_ATTRIBUTION = "Pedestrian routing: local Valhalla on 127.0.0.1 using OpenStreetMap data"
VALHALLA_ATTRIBUTION = "Pedestrian routing: Valhalla (demo endpoint, https://valhalla.openstreetmap.de)"
OSRM_ATTRIBUTION = "Pedestrian routing: OSRM routed-foot (https://routing.openstreetmap.de)"
GOOGLE_MAPS_ATTRIBUTION = "Directions links: Google Maps (https://www.google.com/maps)"


def validate_allowlist() -> list[str]:
    """Self-check run by ``places_doctor``: every endpoint must be plain HTTPS with no
    embedded credentials.  Returns human-readable problems (empty list = OK)."""
    problems: list[str] = []
    from urllib.parse import urlparse

    for key, ep in ENDPOINTS.items():
        parsed = urlparse(ep.url)
        local = key == "valhalla_local"
        expected_scheme = "http" if local else "https"
        if parsed.scheme != expected_scheme:
            problems.append(f"endpoint {key}: scheme is {parsed.scheme!r}, expected {expected_scheme}")
        if not parsed.hostname:
            problems.append(f"endpoint {key}: missing host")
        if local and parsed.hostname != "127.0.0.1":
            problems.append("local Valhalla must use the literal 127.0.0.1 loopback address")
        if parsed.username or parsed.password:
            problems.append(f"endpoint {key}: credentials embedded in URL")
        if ep.max_bytes <= 0 or ep.max_bytes > OVERPASS_MAX_BYTES * 4:
            problems.append(f"endpoint {key}: unreasonable max_bytes {ep.max_bytes}")
    return problems
