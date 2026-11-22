"""Build and validate the shared ``hermes-places`` JSON contract.

Output shape ( fenced ```hermes-places block in the tool result )::

    {version: 1, generated_at, attributions: [...], warnings: [...], places: [1..3]}

Validation is strict: sizes, ranges, HTTPS URLs and enum values are checked so
a provider bug never ships a malformed contract to a client.
"""

from __future__ import annotations

from typing import Any, Optional
from urllib.parse import urlparse, parse_qs

from . import config, sanitize

GOOGLE_MAPS_HOST = "www.google.com"


class ContractError(Exception):
    pass


def _check(cond: bool, message: str) -> None:
    if not cond:
        raise ContractError(message)


def _check_https_url(value: Any, field: str, host: Optional[str] = None,
                     required_query: Optional[dict] = None) -> None:
    _check(isinstance(value, str), f"{field} must be a string")
    parsed = urlparse(value)
    _check(parsed.scheme == "https", f"{field} must be https, got {parsed.scheme!r}")
    _check(bool(parsed.netloc), f"{field} missing host")
    if host is not None:
        _check(parsed.hostname == host, f"{field} host must be {host!r}")
    if required_query:
        query = parse_qs(parsed.query)
        for key, wanted in required_query.items():
            _check(wanted in query.get(key, []), f"{field} query must include {key}={wanted}")


def _directions_query(place: dict) -> dict:
    return parse_qs(urlparse(place["directions_url"]).query)


def validate_place(place: dict) -> None:
    _check(isinstance(place.get("id"), str) and 0 < len(place["id"]) <= 120, "place.id")
    _check(isinstance(place.get("name"), str) and 0 < len(place["name"]) <= 200, "place.name")
    if "address" in place:
        _check(isinstance(place["address"], str) and len(place["address"]) <= 300, "place.address")
    lat, lon = place.get("latitude"), place.get("longitude")
    _check(isinstance(lat, (int, float)) and config.LAT_MIN <= lat <= config.LAT_MAX, "place.latitude")
    _check(isinstance(lon, (int, float)) and config.LON_MIN <= lon <= config.LON_MAX, "place.longitude")
    _check(isinstance(place.get("category"), str) and len(place["category"]) <= 60, "place.category")
    _check_https_url(place.get("directions_url"), "place.directions_url",
                     host=GOOGLE_MAPS_HOST, required_query={"travelmode": "walking"})
    # The origin is deliberately omitted from the link: the phone anchors the
    # route on its own GPS fix, and the caller's position must not be embedded
    # in a URL that gets shared or logged.
    _check("origin" not in _directions_query(place),
           "place.directions_url must not embed an origin (it would leak the caller's position)")

    source = place.get("source")
    _check(isinstance(source, dict), "place.source")
    _check(isinstance(source.get("name"), str) and 0 < len(source["name"]) <= 80, "place.source.name")
    _check(isinstance(source.get("fetched_at"), str)
           and sanitize.parse_iso(source["fetched_at"]) is not None, "place.source.fetched_at")
    if source.get("url") is not None:
        _check_https_url(source["url"], "place.source.url")

    if "distance" in place:
        distance = place["distance"]
        _check(isinstance(distance, dict), "place.distance")
        _check(isinstance(distance.get("meters"), (int, float))
               and 0 < distance["meters"] <= config.RADIUS_MAX_M * 20, "place.distance.meters")
        if distance.get("seconds") is not None:
            _check(distance["kind"] == "route", "distance.seconds requires kind='route'")
            _check(isinstance(distance["seconds"], (int, float))
                   and 0 < distance["seconds"] <= 24 * 3600, "place.distance.seconds")
        _check(distance.get("kind") in {"route", "straight_line"}, "place.distance.kind")
        _check(isinstance(distance.get("source"), str) and len(distance["source"]) <= 40,
               "place.distance.source")

    if "opening" in place:
        opening = place["opening"]
        _check(isinstance(opening, dict), "place.opening")
        _check(opening.get("status") in {"open", "closed", "unknown"}, "place.opening.status")
        _check(isinstance(opening.get("label"), str) and len(opening["label"]) <= 200, "place.opening.label")
        _check(isinstance(opening.get("timezone"), str) and len(opening["timezone"]) <= 60,
               "place.opening.timezone")

    if "features" in place:
        features = place["features"]
        _check(isinstance(features, dict), "place.features")
        for key in ("wifi", "power_outlets"):
            if key in features:
                _check(features[key] is None or isinstance(features[key], bool), f"place.features.{key}")

    if "rating" in place:
        rating = place["rating"]
        _check(isinstance(rating, dict), "place.rating")
        _check(isinstance(rating.get("value"), (int, float)) and 0 <= rating["value"] <= 5, "place.rating.value")
        _check(isinstance(rating.get("count"), int) and rating["count"] >= 0, "place.rating.count")
        _check(isinstance(rating.get("source"), str) and len(rating["source"]) <= 80, "place.rating.source")

    if "reviews" in place:
        reviews = place["reviews"]
        _check(isinstance(reviews, list) and len(reviews) <= 3, "place.reviews (max 3)")
        for review in reviews:
            _check(isinstance(review, dict), "review")
            _check(isinstance(review.get("text"), str) and 0 < len(review["text"]) <= 1000, "review.text")
            if review.get("rating") is not None:
                _check(isinstance(review["rating"], (int, float)) and 0 <= review["rating"] <= 5,
                       "review.rating")
            _check(isinstance(review.get("source"), str) and len(review["source"]) <= 80, "review.source")
            if review.get("url") is not None:
                _check_https_url(review["url"], "review.url")

    if "photo" in place:
        photo = place["photo"]
        _check(isinstance(photo, dict), "place.photo")
        _check(isinstance(photo.get("path"), str) and photo["path"].startswith("/"),
               "place.photo.path must be an absolute local path")
        _check(isinstance(photo.get("attribution"), str) and 0 < len(photo["attribution"]) <= 200,
               "place.photo.attribution")
        if photo.get("source_url") is not None:
            _check_https_url(photo["source_url"], "photo.source_url")


def validate_contract(document: dict) -> None:
    _check(isinstance(document, dict), "contract must be an object")
    _check(document.get("version") == config.CONTRACT_VERSION, "version must be 1")
    _check(isinstance(document.get("generated_at"), str)
           and sanitize.parse_iso(document["generated_at"]) is not None, "generated_at")
    _check(isinstance(document.get("attributions"), list)
           and all(isinstance(a, str) and len(a) <= 300 for a in document["attributions"]),
           "attributions")
    _check(isinstance(document.get("warnings"), list)
           and all(isinstance(w, str) and len(w) <= 300 for w in document["warnings"]), "warnings")
    places = document.get("places")
    _check(isinstance(places, list), "places must be a list")
    _check(1 <= len(places) <= config.MAX_PLACES_RETURNED, "places must contain 1..3 entries")
    seen_ids = set()
    for place in places:
        validate_place(place)
        _check(place["id"] not in seen_ids, f"duplicate place id {place['id']!r}")
        seen_ids.add(place["id"])


def google_maps_walking_url(dest_lat: float, dest_lon: float) -> str:
    """Google Maps directions URL with a destination only.

    The origin is deliberately omitted: the phone then anchors the route on
    its own GPS fix, and the caller's position is never leaked inside the link.
    """
    return ("https://www.google.com/maps/dir/?api=1"
            f"&destination={dest_lat:.6f},{dest_lon:.6f}"
            "&travelmode=walking")


def render(document: dict) -> str:
    """Serialize the contract inside its fenced ```hermes-places block."""
    validate_contract(document)
    import json

    return ("```hermes-places\n"
            + json.dumps(document, ensure_ascii=False, indent=2)
            + "\n```")
