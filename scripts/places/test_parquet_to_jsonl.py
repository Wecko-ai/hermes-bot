#!/usr/bin/env python3
"""Offline tests for Overture JSONL normalization (fake DuckDB, no network)."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


class FakeResult:
    """Minimal stand-in for a DuckDB result: fetchone/fetchall over fixed rows."""

    def __init__(self, rows):
        self.rows = rows

    def fetchone(self):
        return self.rows[0]

    def fetchall(self):
        return self.rows


class FakeConnection:
    """DuckDB double driven by scripted answers, recording every statement."""

    def __init__(self, describe, rows, count):
        self.describe = describe
        self.rows = rows
        self.count = count
        self.calls = []
        self.closed = False

    def connect(self, database=""):
        return self

    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        head = sql.lstrip().upper()
        if head.startswith("DESCRIBE"):
            return FakeResult(self.describe)
        if head.startswith("SELECT COUNT(*)"):
            return FakeResult([(self.count,)])
        if head.startswith("SELECT"):
            return FakeResult(self.rows)
        return self

    def close(self):
        self.closed = True


class ConverterTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location(
            "parquet_to_jsonl", Path(__file__).with_name("parquet_to_jsonl.py")
        )
        self.module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"duckdb": object()}):
            spec.loader.exec_module(self.module)

    def row(self, **overrides):
        values = {
            "id": "abc", "name": "喫茶 藍", "category": "cafe",
            "latitude": 34.65, "longitude": 135.51,
            "addresses": [{"freeform": "1-2-3 Abeno", "locality": "Osaka", "country": "JP"}],
            "confidence": 0.91,
            "sources": [{"dataset": "Foursquare"}, {"dataset": "Overture"}],
        }
        values.update(overrides)
        return (
            values["id"], values["name"], values["category"], values["latitude"],
            values["longitude"], values["addresses"], values["confidence"],
            values["sources"],
        )

    def test_normalizes_japanese_record_and_address(self):
        record = self.module.normalized_row(self.row())
        self.assertEqual(record["name"], "喫茶 藍")
        self.assertEqual(record["address"], "1-2-3 Abeno, Osaka, JP")
        self.assertEqual(record["lat"], 34.65)
        self.assertEqual(record["confidence"], 0.91)

    def test_rejects_bad_names_and_coordinates(self):
        self.assertIsNone(self.module.normalized_row(self.row(name="")))
        self.assertIsNone(self.module.normalized_row(self.row(latitude=91)))
        self.assertIsNone(self.module.normalized_row(self.row(longitude=float("nan"))))
        self.assertIsNone(self.module.normalized_row(self.row(latitude=None)))

    def test_rejects_malformed_identifiers_and_booleans(self):
        self.assertIsNone(self.module.normalized_row(self.row(id=None)))
        self.assertIsNone(self.module.normalized_row(self.row(id="")))
        self.assertIsNone(self.module.normalized_row(self.row(id=True)))
        self.assertIsNone(self.module.normalized_row(self.row(latitude=True)))
        # A non-numeric confidence is optional data: it is omitted, not fatal.
        self.assertNotIn("confidence", self.module.normalized_row(self.row(confidence=True)))

    def test_rejects_empty_category(self):
        self.assertIsNone(self.module.normalized_row(self.row(category="  ")))

    def test_missing_address_is_omitted(self):
        record = self.module.normalized_row(self.row(addresses=[]))
        self.assertNotIn("address", record)

    def test_missing_address_non_list_shapes_are_omitted(self):
        for bad in (None, "1-2-3", [{}], [{"freeform": 5}]):
            record = self.module.normalized_row(self.row(addresses=bad))
            self.assertNotIn("address", record)

    def test_sources_keep_dataset_names_in_order(self):
        record = self.module.normalized_row(self.row())
        self.assertEqual(record["sources"], ["Foursquare", "Overture"])

    def test_sources_omitted_when_empty_or_malformed(self):
        for bad in (None, [], "Foursquare", [{"license": "Apache-2.0"}]):
            record = self.module.normalized_row(self.row(sources=bad))
            self.assertNotIn("sources", record)

    def test_source_names_normalize_trim_dedupe_and_bound(self):
        names = self.module.source_names([
            {"dataset": "  Foursquare  "},
            {"dataset": "foursquare"},                     # duplicate, other case
            {"dataset": "Overture"},
            {"dataset": ""},                               # dropped
            {"dataset": None},                             # dropped
            "not-a-struct",                                # dropped
            {"dataset": "All\n The   Places"},             # whitespace collapsed
            {"dataset": "x" * 200},                        # bounded to 80 chars
        ])
        self.assertEqual(names[0], "Foursquare")
        self.assertEqual(names[1], "Overture")
        self.assertEqual(names[2], "All The Places")
        self.assertEqual(names[3], "x" * 80)
        self.assertEqual(len(names), 4)

    def test_source_names_cap_list_length(self):
        entries = [{"dataset": f"source-{i}"} for i in range(15)]
        self.assertEqual(len(self.module.source_names(entries)), self.module.MAX_SOURCES)


class SchemaSelectionTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location(
            "parquet_to_jsonl", Path(__file__).with_name("parquet_to_jsonl.py")
        )
        self.module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"duckdb": object()}):
            spec.loader.exec_module(self.module)

    def test_normalized_columns_need_no_spatial(self):
        selection, spatial = self.module.select_expressions(
            {"id", "name", "category", "latitude", "longitude"})
        self.assertEqual(selection, "category, latitude, longitude")
        self.assertFalse(spatial)

    def test_raw_basic_category_and_geometry_need_spatial(self):
        selection, spatial = self.module.select_expressions(
            {"id", "basic_category", "geometry", "addresses", "confidence"})
        self.assertIn("basic_category AS category", selection)
        self.assertIn("ST_Y(geometry) AS latitude", selection)
        self.assertIn("ST_X(geometry) AS longitude", selection)
        self.assertTrue(spatial)

    def test_raw_schema_without_flat_name_column_uses_names_struct(self):
        self.assertEqual(
            self.module.name_expression({"id", "basic_category"}),
            "names.primary AS name")
        self.assertEqual(
            self.module.name_expression({"id", "name", "category"}), "name")

    def test_unknown_schema_is_rejected(self):
        with self.assertRaises(SystemExit):
            self.module.select_expressions({"id", "title"})


class ConversionTests(unittest.TestCase):
    """End-to-end conversion through convert() with a fake DuckDB connection."""

    DESCRIBE_NORMALIZED = [(c,) for c in
                           ("id", "name", "category", "latitude", "longitude",
                            "addresses", "confidence", "sources")]
    DESCRIBE_RAW = [(c,) for c in
                    ("id", "names", "basic_category", "geometry",
                     "addresses", "confidence")]

    SOURCES = [{"dataset": "Foursquare"}, {"dataset": "Overture"}]

    ROWS = [
        ("abc", "喫茶 藍", "cafe", 34.65, 135.51,
         [{"freeform": "1-2-3 Abeno", "locality": "Osaka", "country": "JP"}],
         0.91, SOURCES),
        (None, "No id", "cafe", 34.6, 135.5, [], 0.5, SOURCES),              # skipped
        ("def", "", "cafe", 34.6, 135.5, [], 0.5, SOURCES),                  # skipped
        ("ghi", "Bad coords", "cafe", 999.0, 135.5, [], 0.5, SOURCES),       # skipped
        ("jkl", "Far away", "cafe", 34.6, 135.5, [], 0.5, SOURCES),          # kept
    ]

    def setUp(self):
        spec = importlib.util.spec_from_file_location(
            "parquet_to_jsonl", Path(__file__).with_name("parquet_to_jsonl.py")
        )
        self.module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"duckdb": object()}):
            spec.loader.exec_module(self.module)

    def convert(self, describe, rows, count):
        connection = FakeConnection(describe, rows, count)
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        output = Path(folder.name) / "cafes.jsonl"
        written = self.module.convert(connection, Path("/in.parquet"), output)
        return connection, output, written

    def test_main_conversion_skips_malformed_rows(self):
        connection, output, written = self.convert(
            self.DESCRIBE_NORMALIZED, self.ROWS, len(self.ROWS))
        self.assertEqual(written, 2)
        lines = output.read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(lines), 2)
        records = [json.loads(line) for line in lines]
        self.assertEqual([r["id"] for r in records], ["abc", "jkl"])
        self.assertEqual(records[0]["address"], "1-2-3 Abeno, Osaka, JP")
        self.assertNotIn("address", records[1])
        self.assertEqual(records[0]["sources"], ["Foursquare", "Overture"])
        self.assertEqual(records[1]["sources"], ["Foursquare", "Overture"])
        select = next(sql for sql, _ in connection.calls
                      if sql.lstrip().upper().startswith("SELECT ID"))
        self.assertIn(", sources", select)
        # Plain normalized schema: no spatial extension was loaded.
        self.assertFalse(any("spatial" in sql for sql, _ in connection.calls))
        metadata = json.loads(output.with_suffix(".jsonl.json").read_text())
        self.assertEqual(metadata["count"], 2)
        self.assertEqual(metadata["skipped"], 3)
        self.assertFalse(metadata["truncated"])

    def test_raw_schema_converts_with_spatial(self):
        rows = [
            ("abc", "Cafe Raw", "cafe", 34.65, 135.51, [], 0.8, self.SOURCES),
        ]
        connection, output, written = self.convert(self.DESCRIBE_RAW, rows, 1)
        self.assertEqual(written, 1)
        select = next(sql for sql, _ in connection.calls if sql.lstrip().upper().startswith("SELECT ID"))
        self.assertIn("names.primary AS name", select)
        self.assertIn("ST_Y(geometry) AS latitude", select)
        # The raw describe above omits a sources column: the query synthesizes NULL.
        self.assertIn("NULL AS sources", select)
        self.assertTrue(any("spatial" in sql for sql, _ in connection.calls))
        record = json.loads(output.read_text(encoding="utf-8").strip())
        self.assertEqual(record["name"], "Cafe Raw")
        self.assertEqual(record["category"], "cafe")
        self.assertEqual(record["sources"], ["Foursquare", "Overture"])

    def test_raw_schema_without_sources_column_omits_the_field(self):
        rows = [("abc", "Cafe Raw", "cafe", 34.65, 135.51, [], 0.8, None)]
        connection, output, written = self.convert(self.DESCRIBE_RAW, rows, 1)
        self.assertEqual(written, 1)
        record = json.loads(output.read_text(encoding="utf-8").strip())
        self.assertNotIn("sources", record)

    def test_never_replaces_existing_output_or_metadata(self):
        for setup in ("output", "metadata"):
            with self.subTest(setup=setup), tempfile.TemporaryDirectory() as folder:
                output = Path(folder) / "cafes.jsonl"
                (output if setup == "output"
                 else output.with_suffix(".jsonl.json")).write_text("keep")
                connection = FakeConnection(self.DESCRIBE_NORMALIZED, self.ROWS, 5)
                with self.assertRaises(SystemExit):
                    self.module.convert(connection, Path("/in.parquet"), output)
                self.assertEqual((output if setup == "output"
                                  else output.with_suffix(".jsonl.json")).read_text(), "keep")
                # Refusal happens before any query is issued.
                self.assertEqual(connection.calls, [])

    def test_empty_result_preserves_partial_for_diagnosis(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        output = Path(folder.name) / "cafes.jsonl"
        connection = FakeConnection(
            self.DESCRIBE_NORMALIZED,
            [("abc", "", "cafe", 34.6, 135.5, [], 0.5, self.SOURCES)], 1)
        with self.assertRaises(SystemExit) as caught:
            self.module.convert(connection, Path("/in.parquet"), output)
        self.assertIn("partial JSONL preserved", str(caught.exception))
        self.assertFalse(output.exists())
        self.assertEqual(len(list(output.parent.glob(".*.tmp"))), 1)

    def test_plugin_caps_are_mirrored_and_lines_stay_bounded(self):
        self.assertEqual(self.module.MAX_LINES, 500_000)
        self.assertEqual(self.module.MAX_LINE_BYTES, 64_000)
        self.assertEqual(self.module.MAX_JSONL_BYTES, 200_000_000)
        huge_name = "x" * 70_000
        connection, output, written = self.convert(
            self.DESCRIBE_NORMALIZED,
            [("abc", huge_name, "cafe", 34.6, 135.5, [], 0.5, self.SOURCES)], 1)
        # The 200-char display cap keeps names well under MAX_LINE_BYTES, so the
        # record is kept; the cap itself is a defensive bound for hostile data.
        self.assertEqual(written, 1)
        for line in output.read_bytes().splitlines():
            self.assertLessEqual(len(line), self.module.MAX_LINE_BYTES)


if __name__ == "__main__":
    unittest.main()
