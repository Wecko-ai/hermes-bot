#!/usr/bin/env python3
"""Offline tests for the Overture extract importer."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


class FakeResult:
    def __init__(self, count):
        self.count = count

    def fetchone(self):
        return (self.count,)


class FakeConnection:
    count = 2
    calls = []

    def connect(self):
        return self

    def execute(self, sql, params=None):
        type(self).calls.append((sql, params))
        if sql.lstrip().startswith("COPY"):
            marker = "TO '"
            destination = sql.split(marker, 1)[1].split("'", 1)[0]
            Path(destination).write_bytes(b"parquet-fixture")
            return self
        if "count(*)" in sql:
            return FakeResult(self.count)
        return self


class ImportOvertureTests(unittest.TestCase):
    def setUp(self):
        FakeConnection.calls = []
        FakeConnection.count = 2
        spec = importlib.util.spec_from_file_location(
            "import_overture", Path(__file__).with_name("import_overture.py")
        )
        self.module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"duckdb": FakeConnection()}):
            spec.loader.exec_module(self.module)
        self.module.duckdb = FakeConnection()

    def invoke(self, output, *extra):
        argv = [
            "import_overture.py", "--output", str(output), "--release", "2026-11-18.0",
            "--west", "135.35", "--south", "34.50", "--east", "135.75", "--north", "34.85",
            *extra,
        ]
        with patch.object(sys, "argv", argv):
            self.module.main()

    def test_writes_extract_and_metadata_with_s3_source(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "cafes.parquet"
            self.invoke(output)
            self.assertTrue(output.is_file())
            metadata = json.loads(output.with_suffix(".parquet.json").read_text())
            self.assertEqual(metadata["count"], 2)
            self.assertEqual(metadata["release"], "2026-11-18.0")
            copy = next(sql for sql, _ in FakeConnection.calls if sql.lstrip().startswith("COPY"))
            self.assertIn("s3://overturemaps-us-west-2", copy)
            self.assertIn("basic_category = 'cafe'", copy)
            self.assertIn("basic_category AS category", copy)
            self.assertIn("ST_Y(geometry) AS latitude", copy)
            self.assertIn("ST_X(geometry) AS longitude", copy)
            self.assertIn("135.35", copy)

    def test_existing_output_is_never_replaced(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "cafes.parquet"
            output.write_bytes(b"keep")
            with self.assertRaises(SystemExit):
                self.invoke(output)
            self.assertEqual(output.read_bytes(), b"keep")

    def test_existing_metadata_is_never_replaced_and_blocks_import(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "cafes.parquet"
            output.with_suffix(".parquet.json").write_text("keep", encoding="utf-8")
            with self.assertRaises(SystemExit):
                self.invoke(output)
            self.assertEqual(
                output.with_suffix(".parquet.json").read_text(encoding="utf-8"), "keep")
            self.assertFalse(output.exists())
            self.assertFalse(
                any(sql.lstrip().startswith("COPY") for sql, _ in FakeConnection.calls))

    def test_invalid_release_and_bbox_fail_before_network(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "cafes.parquet"
            with self.assertRaises(SystemExit):
                self.invoke(output, "--release", "latest")
            with self.assertRaises(SystemExit):
                self.invoke(output, "--east", "134")
            self.assertFalse(output.exists())

    def test_empty_result_preserves_partial_for_diagnosis(self):
        FakeConnection.count = 0
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "cafes.parquet"
            with self.assertRaises(SystemExit) as caught:
                self.invoke(output)
            self.assertIn("partial extract preserved", str(caught.exception))
            self.assertFalse(output.exists())
            self.assertEqual(len(list(Path(folder).glob(".*.tmp"))), 1)


if __name__ == "__main__":
    unittest.main()
