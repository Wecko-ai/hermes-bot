"""Tool handlers, registration contract and places_doctor — all offline."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from places.tests.helpers import (FakeCtx, FakeNet,  # noqa: F401
                                  overpass_responder, valhalla_ok)

from places import tools
from places.core import net

ORIGIN = (48.8570, 2.3519)


def runtime_for(home: Path, fake: FakeNet | None = None) -> tools.Runtime:
    rt = tools.Runtime("testprofile", io=(fake.io() if fake else None))
    rt._home = home
    return rt


class HandlerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.fake = FakeNet({"overpass_de": overpass_responder("overpass_cafe.json"),
                             "valhalla": valhalla_ok()})

    def tearDown(self):
        self.tmp.cleanup()

    def test_nearby_returns_fenced_contract(self):
        rt = runtime_for(self.home, self.fake)
        out = tools.handle_places_nearby(
            {"category": "cafe", "latitude": ORIGIN[0], "longitude": ORIGIN[1]},
            _runtime=rt)
        self.assertTrue(out.startswith("```hermes-places\n"), out[:100])
        doc = json.loads(out[len("```hermes-places\n"):-len("\n```")])
        self.assertEqual(len(doc["places"]), 3)
        # cache was written under the temp home, scoped by profile
        self.assertTrue((self.home / "cache" / "places" / "testprofile.json").is_file())

    def test_nearby_missing_args(self):
        out = tools.handle_places_nearby({"category": "cafe"}, _runtime=runtime_for(self.home, self.fake))
        self.assertIn("Error", out)

    def test_nearby_unknown_category(self):
        out = tools.handle_places_nearby(
            {"category": "casino", "latitude": ORIGIN[0], "longitude": ORIGIN[1]},
            _runtime=runtime_for(self.home, self.fake))
        self.assertIn("Error", out)
        self.assertIn("supported", out)

    def test_nearby_total_failure_message(self):
        broken = FakeNet({"overpass_de": net.Timeout("t"), "overpass_kumi": net.Timeout("t")})
        rt = runtime_for(self.home, broken)
        out = tools.handle_places_nearby(
            {"category": "cafe", "latitude": ORIGIN[0], "longitude": ORIGIN[1]},
            _runtime=rt)
        self.assertIn("No places found", out)
        self.assertIn("all place providers failed", out)

    def test_nearby_empty_result_message(self):
        empty = FakeNet({"overpass_de": overpass_responder("overpass_empty.json")})
        rt = runtime_for(self.home, empty)
        out = tools.handle_places_nearby(
            {"category": "cafe", "latitude": ORIGIN[0], "longitude": ORIGIN[1]},
            _runtime=rt)
        self.assertIn("No places found", out)
        self.assertIn("no places matched", out)
        self.assertNotIn("all place providers failed", out)

    def test_runtime_home_env_fallback(self):
        with mock.patch.dict(os.environ, {"HERMES_HOME": str(self.home)}, clear=False):
            rt = tools.Runtime("testprofile")
            self.assertEqual(rt.home, self.home)

    def test_runtime_home_unresolvable(self):
        env = dict(os.environ)
        env.pop("HERMES_HOME", None)
        with mock.patch.dict(os.environ, env, clear=True):
            with mock.patch.dict("sys.modules", {"hermes_constants": None}):
                rt = tools.Runtime("testprofile")
                out = tools.handle_places_nearby(
                    {"category": "cafe", "latitude": ORIGIN[0], "longitude": ORIGIN[1]},
                    _runtime=rt)
        self.assertIn("Error", out)
        self.assertIn("Hermes home", out)

    def test_settings_config_jsonl(self):
        (self.home / "places").mkdir(parents=True)
        (self.home / "places" / "config.json").write_text(json.dumps(
            {"overture_jsonl": str(Path(__file__).resolve().parent / "fixtures" / "overture_cafes.jsonl")}))
        rt = runtime_for(self.home, self.fake)
        settings, error = rt.settings()
        self.assertIsNone(error)
        self.assertIn("overture_jsonl", settings)
        self.assertIsInstance(rt.adapter(), object)

    def test_settings_rejects_relative_path(self):
        (self.home / "places").mkdir(parents=True)
        (self.home / "places" / "config.json").write_text(json.dumps({"overture_jsonl": "rel/x.jsonl"}))
        rt = runtime_for(self.home, self.fake)
        _, error = rt.settings()
        self.assertIn("absolute", error)

    def test_settings_invalid_json(self):
        (self.home / "places").mkdir(parents=True)
        (self.home / "places" / "config.json").write_text("{ nope")
        rt = runtime_for(self.home, self.fake)
        _, error = rt.settings()
        self.assertIsNotNone(error)


class RegisterTests(unittest.TestCase):
    def test_register_tools_contract(self):
        ctx = FakeCtx(profile="testprofile")
        tools.register_tools(ctx)
        self.assertEqual(set(ctx.registered), {"places_nearby", "places_doctor"})
        for name, entry in ctx.registered.items():
            self.assertEqual(entry["toolset"], "places")
            schema = entry["schema"]
            self.assertEqual(schema["name"], name)
            self.assertIn("parameters", schema)
        nearby = ctx.registered["places_nearby"]["schema"]["parameters"]
        self.assertIn("category", nearby["required"])
        self.assertIn("latitude", nearby["required"])
        self.assertIn("longitude", nearby["required"])
        # limit is capped at 3 in the schema itself
        self.assertEqual(nearby["properties"]["limit"]["maximum"], 3)

    def test_registered_handlers_run_offline(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake = FakeNet({"overpass_de": overpass_responder("overpass_cafe.json"),
                            "valhalla": valhalla_ok()})
            ctx = FakeCtx()
            with mock.patch.object(tools, "_make_runtime",
                                   side_effect=lambda profile: runtime_for(Path(tmp), fake)):
                tools.register_tools(ctx)
                out = ctx.registered["places_nearby"]["handler"](
                    {"category": "cafe", "latitude": ORIGIN[0], "longitude": ORIGIN[1]})
            self.assertTrue(out.startswith("```hermes-places\n"))


class LoaderCompatibilityTests(unittest.TestCase):
    """Load the plugin the way hermes_cli.plugins_loader._load_directory_module does
    (synthetic ``hermes_plugins.<slug>`` namespace) and register against a fake ctx."""

    def test_synthetic_namespace_load_registers_tools(self):
        import importlib.util
        import types

        plugin_dir = Path(__file__).resolve().parents[1]
        name = "hermes_plugins.places"
        for key in [k for k in sys.modules if k == name or k.startswith(name + ".")]:
            del sys.modules[key]
        if "hermes_plugins" not in sys.modules:
            pkg = types.ModuleType("hermes_plugins")
            pkg.__path__ = []  # type: ignore[attr-defined]
            sys.modules["hermes_plugins"] = pkg
        spec = importlib.util.spec_from_file_location(
            name, plugin_dir / "__init__.py", submodule_search_locations=[str(plugin_dir)])
        module = importlib.util.module_from_spec(spec)
        module.__package__ = name
        sys.modules[name] = module
        spec.loader.exec_module(module)

        ctx = FakeCtx()
        module.register(ctx)
        self.assertEqual(set(ctx.registered), {"places_nearby", "places_doctor"})


class DoctorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.fake = FakeNet({"overpass_de": overpass_responder("overpass_cafe.json"),
                             "valhalla_local": valhalla_ok(),
                             "valhalla": valhalla_ok()})

    def tearDown(self):
        self.tmp.cleanup()

    def _doctor(self, args, fake=None):
        rt = runtime_for(self.home, fake or self.fake)
        out = tools.handle_places_doctor(args, _runtime=rt)
        assert out.startswith("```json\n")
        return json.loads(out[len("```json\n"):-len("\n```")])

    def test_doctor_ok_offline(self):
        report = self._doctor({})
        self.assertTrue(report["ok"])
        checks = {c["check"]: c for c in report["checks"]}
        self.assertTrue(checks["endpoint_allowlist"]["ok"])
        self.assertTrue(checks["hermes_home"]["ok"])
        self.assertTrue(checks["cache"]["ok"])
        self.assertTrue(checks["settings"]["ok"])
        self.assertTrue(checks["overture_adapter"]["ok"])

    def test_doctor_probe_success(self):
        report = self._doctor({"probe": True})
        checks = {c["check"]: c for c in report["checks"]}
        self.assertTrue(checks["live_probe"]["ok"], checks["live_probe"])
        self.assertNotIn("degraded", report)
        self.assertTrue(checks["local_valhalla"]["ok"], checks["local_valhalla"])

    def test_doctor_probe_local_valhalla_degraded_not_failed(self):
        # local Valhalla silent but public providers answer: degraded, still usable
        fake = FakeNet({"overpass_de": overpass_responder("overpass_cafe.json"),
                        "valhalla_local": net.NetError("connection refused"),
                        "valhalla": valhalla_ok()})
        report = self._doctor({"probe": True}, fake=fake)
        checks = {c["check"]: c for c in report["checks"]}
        self.assertTrue(report["ok"])  # degraded must not flip the overall status
        self.assertTrue(report["degraded"])
        self.assertTrue(checks["live_probe"]["ok"], checks["live_probe"])
        self.assertIn("degraded", checks["live_probe"]["detail"])
        self.assertFalse(checks["local_valhalla"]["ok"])
        self.assertIn("falls back", checks["local_valhalla"]["detail"])

    def test_doctor_probe_overpass_degraded_not_failed(self):
        broken = FakeNet({"overpass_de": net.Timeout("t"), "valhalla_local": valhalla_ok(), "valhalla": valhalla_ok()})
        report = self._doctor({"probe": True}, fake=broken)
        checks = {c["check"]: c for c in report["checks"]}
        self.assertTrue(report["ok"])
        self.assertTrue(report["degraded"])
        self.assertTrue(checks["live_probe"]["ok"], checks["live_probe"])
        self.assertIn("overpass", checks["live_probe"]["detail"])
        self.assertIn("local fallbacks remain available", checks["live_probe"]["detail"])

    def test_doctor_probe_failure_reported(self):
        broken = FakeNet({"overpass_de": net.Timeout("t"), "valhalla": net.Timeout("t")})
        report = self._doctor({"probe": True}, fake=broken)
        checks = {c["check"]: c for c in report["checks"]}
        self.assertFalse(checks["live_probe"]["ok"])
        self.assertFalse(report["ok"])
        self.assertIn("no Valhalla endpoint answered", checks["live_probe"]["detail"])

    def test_doctor_takes_no_coordinates(self):
        # the doctor schema exposes no lat/lon: diagnostics never handle a precise origin
        props = tools.SCHEMAS["places_doctor"]["parameters"]["properties"]
        self.assertNotIn("latitude", props)
        self.assertNotIn("longitude", props)
        report = self._doctor({"probe": True})
        self.assertTrue(any(c["check"] == "live_probe" for c in report["checks"]))


if __name__ == "__main__":
    unittest.main()
