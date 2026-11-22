"""OpenStreetMap POI search through two Overpass mirrors with bounded retries.

A raw POI record produced here is a plain dict:

    {"source_id": "osm:node/123", "name": "...", "lat": ..., "lon": ...,
     "address": "..." or None, "category": "<requested category>",
     "features": {"wifi": bool|None, "power_outlets": bool|None} or None,
     "tags": {...} }   # tags kept for feature extraction, dropped by the engine

Malformed elements are skipped individually; a malformed *document* (missing
``elements``) raises :class:`OverpassError` so the caller can fail over or fall
back.  An empty-but-valid document is a legitimate "no results" answer and is
cached as such.
"""

from __future__ import annotations

import urllib.parse
from typing import Any, Optional

from . import config, geo, net, sanitize


class OverpassError(Exception):
    pass


def build_query(tag_pairs: list[tuple[str, str]], lat: float, lon: float, radius_m: float) -> str:
    filters = "\n".join(
        f'  {kind}["{key}"="{value}"](around:{int(radius_m)},{lat:.6f},{lon:.6f});'
        for key, value in tag_pairs
        for kind in ("node", "way", "relation")
    )
    return (
        "[out:json][timeout:25];\n(\n"
        f"{filters}\n"
        ");\nout center tags 25;"
    )


def _features_from_tags(tags: dict) -> Optional[dict]:
    wifi: Optional[bool] = None
    internet = str(tags.get("internet_access", "")).lower()
    if internet in {"wlan", "wifi", "yes", "y"}:
        wifi = True
    elif internet == "no":
        wifi = False

    power: Optional[bool] = None
    socket_values = [str(v).lower() for k, v in tags.items()
                     if str(k).startswith("socket:")]
    if any(v not in {"no", "none", ""} for v in socket_values):
        power = True
    elif socket_values and all(v in {"no", "none"} for v in socket_values):
        power = False
    elif str(tags.get("power_supply", "")).lower() in {"yes", "y"}:
        power = True
    elif str(tags.get("power_supply", "")).lower() == "no":
        power = False

    if wifi is None and power is None:
        return None
    return {"wifi": wifi, "power_outlets": power}


def _address_from_tags(tags: dict) -> Optional[str]:
    parts = []
    housenumber = sanitize.bounded_str(tags.get("addr:housenumber"), 20)
    street = sanitize.bounded_str(tags.get("addr:street"), 120)
    if street and housenumber:
        parts.append(f"{street} {housenumber}")
    elif street:
        parts.append(street)
    elif housenumber:
        parts.append(housenumber)
    city = sanitize.bounded_str(tags.get("addr:city") or tags.get("addr:town") or tags.get("addr:village"), 80)
    if city:
        parts.append(city)
    postcode = sanitize.bounded_str(tags.get("addr:postcode"), 12)
    if postcode:
        parts.append(postcode)
    return ", ".join(parts) if parts else None


def parse_elements(document: Any, category: str) -> list[dict]:
    """Validate the Overpass document and convert elements to raw POI records."""
    if not isinstance(document, dict) or not isinstance(document.get("elements"), list):
        raise OverpassError("overpass response is not a JSON object with an 'elements' list")
    pois: list[dict] = []
    for el in document["elements"]:
        if not isinstance(el, dict):
            continue
        el_type = el.get("type")
        el_id = el.get("id")
        if el_type not in {"node", "way", "relation"} or not isinstance(el_id, int):
            continue
        tags = el.get("tags")
        if not isinstance(tags, dict):
            continue
        name = sanitize.bounded_str(tags.get("name") or tags.get("brand"), 200)
        if not name:
            continue  # unnamed POIs are not useful to the assistant
        if el_type == "node":
            lat, lon = el.get("lat"), el.get("lon")
        else:
            center = el.get("center")
            if not isinstance(center, dict):
                continue
            lat, lon = center.get("lat"), center.get("lon")
        if not geo.valid_lat_lon(lat, lon):
            continue
        pois.append({
            "source_id": f"osm:{el_type}/{el_id}",
            "name": name,
            "lat": float(lat),
            "lon": float(lon),
            "address": _address_from_tags(tags),
            "category": category,
            "features": _features_from_tags(tags),
            "tags": {str(k)[:60]: str(v)[:200] for k, v in tags.items()},
        })
    return pois


def search(category: str, lat: float, lon: float, radius_m: float,
           io: net.Io, budget: net.Budget) -> tuple[list[dict], str]:
    """Query the mirrors in order; return ``(pois, fetched_at)``.

    Raises :class:`OverpassError` only when every mirror failed; the message is
    the bounded reason of the *last* attempt.
    """
    spec = config.CATEGORIES.get(category)
    if spec is None:
        raise OverpassError(f"unknown category {category!r}")
    query = build_query(spec["osm"], lat, lon, radius_m)
    body = ("data=" + urllib.parse.quote(query)).encode("utf-8")

    last_error: Optional[Exception] = None
    for mirror_key in config.OVERPASS_MIRROR_KEYS:
        endpoint = config.ENDPOINTS[mirror_key]
        for _attempt in range(config.OVERPASS_ATTEMPTS):
            if budget.exhausted():
                raise OverpassError("time budget exhausted before overpass succeeded")
            try:
                document = net.request_json(
                    "POST", endpoint.url,
                    body=body,
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                    timeout_s=budget.take(endpoint.timeout_s),
                    max_bytes=endpoint.max_bytes,
                    io=io,
                )
                return parse_elements(document, category), io.now_iso()
            except net.NetError as exc:
                last_error = exc
                continue
    raise OverpassError(f"all overpass mirrors failed: {last_error}")
