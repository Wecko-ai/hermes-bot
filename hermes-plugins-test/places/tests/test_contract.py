"""Shared hermes-places contract: builder and strict validation."""

from __future__ import annotations

import unittest

from places.tests.helpers import NOW

from places.core import contract


def valid_place(**over):
    place = {
        "id": "osm:node/1001",
        "name": "Cafe du Coin",
        "address": "12 Rue de la Lune, Paris",
        "latitude": 48.85702,
        "longitude": 2.35152,
        "category": "cafe",
        # destination only: no origin in the link (the phone uses its GPS fix)
        "directions_url": ("https://www.google.com/maps/dir/?api=1"
                           "&destination=48.857020,2.351520&travelmode=walking"),
        "source": {"name": "OpenStreetMap",
                   "url": "https://www.openstreetmap.org/node/1001",
                   "fetched_at": NOW},
        "distance": {"meters": 62.0, "seconds": 45, "kind": "route", "source": "valhalla"},
        "features": {"wifi": True, "power_outlets": None},
    }
    place.update(over)
    return place


def valid_doc(**over):
    doc = {
        "version": 1,
        "generated_at": NOW,
        "attributions": ["© OpenStreetMap contributors"],
        "warnings": [],
        "places": [valid_place()],
    }
    doc.update(over)
    return doc


class ContractValidateTests(unittest.TestCase):
    def test_valid_document_passes(self):
        contract.validate_contract(valid_doc())

    def test_min_and_max_place_count(self):
        contract.validate_contract(valid_doc(places=[valid_place()]))
        with self.assertRaises(contract.ContractError):
            contract.validate_contract(valid_doc(places=[]))
        with self.assertRaises(contract.ContractError):
            contract.validate_contract(valid_doc(places=[valid_place(id=f"p{i}") for i in range(4)]))

    def test_duplicate_ids_rejected(self):
        with self.assertRaises(contract.ContractError):
            contract.validate_contract(valid_doc(places=[valid_place(), valid_place()]))

    def test_coordinate_ranges(self):
        with self.assertRaises(contract.ContractError):
            contract.validate_contract(valid_doc(places=[valid_place(latitude=91.0)]))
        with self.assertRaises(contract.ContractError):
            contract.validate_contract(valid_doc(places=[valid_place(longitude=-181.0)]))

    def test_directions_url_must_be_google_https_walking(self):
        with self.assertRaises(contract.ContractError):
            contract.validate_contract(valid_doc(places=[valid_place(
                directions_url="http://www.google.com/maps/dir/?travelmode=walking")]))
        with self.assertRaises(contract.ContractError):
            contract.validate_contract(valid_doc(places=[valid_place(
                directions_url="https://evil.example.com/maps?travelmode=walking")]))
        with self.assertRaises(contract.ContractError):
            contract.validate_contract(valid_doc(places=[valid_place(
                directions_url="https://www.google.com/maps/dir/?travelmode=driving")]))

    def test_directions_url_must_not_embed_origin(self):
        with self.assertRaises(contract.ContractError):
            contract.validate_contract(valid_doc(places=[valid_place(
                directions_url=("https://www.google.com/maps/dir/?api=1"
                                "&origin=48.857000,2.351900"
                                "&destination=48.857020,2.351520&travelmode=walking"))]))

    def test_source_requires_https_and_iso_time(self):
        with self.assertRaises(contract.ContractError):
            contract.validate_contract(valid_doc(places=[valid_place(
                source={"name": "OSM", "url": "ftp://x", "fetched_at": NOW})]))
        with self.assertRaises(contract.ContractError):
            contract.validate_contract(valid_doc(places=[valid_place(
                source={"name": "OSM", "fetched_at": "yesterday"})]))

    def test_straight_line_must_not_carry_seconds(self):
        with self.assertRaises(contract.ContractError):
            contract.validate_contract(valid_doc(places=[valid_place(
                distance={"meters": 40.0, "seconds": 30, "kind": "straight_line",
                          "source": "haversine"})]))
        contract.validate_contract(valid_doc(places=[valid_place(
            distance={"meters": 40.0, "kind": "straight_line", "source": "haversine"})]))

    def test_reviews_capped_at_three_and_bounded(self):
        reviews = [{"text": "nice", "rating": 5, "source": "maps"} for _ in range(3)]
        contract.validate_contract(valid_doc(places=[valid_place(reviews=reviews)]))
        with self.assertRaises(contract.ContractError):
            contract.validate_contract(valid_doc(places=[valid_place(reviews=reviews + reviews[:1])]))
        with self.assertRaises(contract.ContractError):
            contract.validate_contract(valid_doc(places=[valid_place(
                reviews=[{"text": "x", "source": "s", "rating": 9}])]))

    def test_rating_range(self):
        with self.assertRaises(contract.ContractError):
            contract.validate_contract(valid_doc(places=[valid_place(
                rating={"value": 5.5, "count": 3, "source": "maps"})]))

    def test_photo_path_must_be_absolute_local(self):
        contract.validate_contract(valid_doc(places=[valid_place(
            photo={"path": "/var/places/x.jpg", "attribution": "own photo"})]))
        with self.assertRaises(contract.ContractError):
            contract.validate_contract(valid_doc(places=[valid_place(
                photo={"path": "relative/x.jpg", "attribution": "own photo"})]))
        with self.assertRaises(contract.ContractError):
            contract.validate_contract(valid_doc(places=[valid_place(
                photo={"path": "/var/places/x.jpg"})]))  # attribution required

    def test_version_and_timestamps(self):
        with self.assertRaises(contract.ContractError):
            contract.validate_contract(valid_doc(version=2))
        with self.assertRaises(contract.ContractError):
            contract.validate_contract(valid_doc(generated_at="not-a-time"))


class ContractRenderTests(unittest.TestCase):
    def test_render_wraps_in_hermes_places_fence(self):
        out = contract.render(valid_doc())
        self.assertTrue(out.startswith("```hermes-places\n"))
        self.assertTrue(out.endswith("\n```"))

    def test_render_rejects_invalid(self):
        with self.assertRaises(contract.ContractError):
            contract.render(valid_doc(places=[]))

    def test_google_maps_walking_url_format(self):
        url = contract.google_maps_walking_url(48.85702, 2.35152)
        self.assertEqual(
            url,
            "https://www.google.com/maps/dir/?api=1"
            "&destination=48.857020,2.351520&travelmode=walking")
        self.assertNotIn("origin=", url)  # the caller's position never goes in the link


if __name__ == "__main__":
    unittest.main()
