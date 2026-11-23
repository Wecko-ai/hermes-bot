from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "zero_spend_guard",
    Path(__file__).resolve().parent.parent / "__init__.py",
)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.enabled = patch.object(guard, "enabled", return_value=True)
        self.enabled.start()

    def tearDown(self):
        self.enabled.stop()

    def allow(self, provider, model, base_url):
        self.assertIsNone(guard.policy_decision(provider, model, base_url))

    def deny(self, provider, model, base_url):
        self.assertIsNotNone(guard.policy_decision(provider, model, base_url))

    def test_openrouter_only_free_models(self):
        self.allow("openrouter", "nvidia/nemotron-3-ultra:free", "https://openrouter.ai/api/v1")
        self.deny("openrouter", "openai/gpt-5.5", "https://openrouter.ai/api/v1")

    def test_local_only_on_loopback(self):
        self.allow("ollama", "llama3", "http://127.0.0.1:11434/v1")
        self.deny("ollama", "llama3", "https://api.example.com/v1")

    def test_cursor_requires_env_port(self):
        self.deny("cursor", "cursor/auto", "http://127.0.0.1:10100/v1")
        with patch.dict("os.environ", {"ZERO_SPEND_CURSOR_PROXY_PORT": "10100"}):
            self.allow("cursor", "cursor/auto", "http://127.0.0.1:10100/v1")
            self.deny("cursor", "openai/gpt-5.5", "http://127.0.0.1:10100/v1")

    def test_disabled_setting_allows(self):
        self.enabled.stop()
        with patch.object(guard, "enabled", return_value=False):
            self.assertIsNone(guard.policy_decision("openai", "gpt-5.5", "https://api.openai.com/v1"))
        self.enabled.start()

    def test_settings_default_off(self):
        self.enabled.stop()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                settings = Path(tmp) / "settings.json"
                with patch.object(guard, "SETTINGS_FILE", settings):
                    self.assertFalse(guard.enabled())
                    settings.write_text('{"zeroSpend": true}', "utf-8")
                    self.assertTrue(guard.enabled())
        finally:
            self.enabled.start()

    def test_audit_contains_no_secrets(self):
        with tempfile.TemporaryDirectory() as tmp:
            audit = Path(tmp) / "audit.jsonl"
            with patch.object(guard, "AUDIT_FILE", audit), patch.object(guard, "_profile", return_value="test"):
                verdict = guard._verdict("openai", "gpt-5.5", "https://user:secret@api.openai.com/v1", "cli")
            self.assertEqual(verdict["action"], "block")
            row = json.loads(audit.read_text("utf-8"))
            self.assertEqual(set(row), {"at", "profile", "provider", "model", "host", "surface", "reason"})
            self.assertNotIn("secret", audit.read_text("utf-8"))


if __name__ == "__main__":
    unittest.main()