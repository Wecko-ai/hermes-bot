"""HermesBot installer: named profiles only, dry run by default, config backed up."""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "install.sh"


class InstallTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "profiles" / "alice").mkdir(parents=True)
        (self.root / "profiles" / "alice" / "config.yaml").write_text("model: x\n")
        self.log = self.root / "hermes.log"
        stub = self.root / "hermes"
        stub.write_text(f"#!/bin/sh\necho \"$@\" >> {self.log}\n")
        stub.chmod(0o755)
        self.env = {**os.environ, "HERMES_ROOT": str(self.root), "HERMES_BIN": str(stub)}

    def tearDown(self):
        self.tmp.cleanup()

    def run_script(self, *args):
        return subprocess.run(["bash", str(SCRIPT), *args], env=self.env, capture_output=True, text=True)

    def test_profiles_are_required(self):
        done = self.run_script()
        self.assertEqual(done.returncode, 2)
        self.assertIn("--profiles is required", done.stderr)

    def test_dry_run_changes_nothing(self):
        done = self.run_script("--profiles", "alice", "--from", "a@b.co")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("dry run", done.stdout)
        self.assertFalse((self.root / "profiles" / "alice" / "plugins").exists())
        self.assertFalse(self.log.exists())

    def test_apply_installs_enables_and_backs_up(self):
        done = self.run_script("--profiles", "alice", "--from", "a@b.co", "--account", "contact", "--apply")
        self.assertEqual(done.returncode, 0, done.stderr)
        home = self.root / "profiles" / "alice"
        self.assertTrue((home / "plugins" / "email-drafts" / "__init__.py").is_file())
        self.assertTrue(any(p.name.startswith("config.yaml.bak-email-drafts-") for p in home.iterdir()))
        log = self.log.read_text()
        self.assertIn("--profile alice plugins enable email-drafts", log)
        self.assertIn("config set plugins.entries.email-drafts.settings.from_address a@b.co", log)
        self.assertIn("settings.himalaya_account contact", log)
        self.assertFalse((home / "plugins" / "email-drafts" / "tests").exists())
        self.assertTrue((home / "plugins" / "email-drafts" / "LICENSE").is_file())
        self.assertFalse((home / "plugin-data" / "email-drafts" / "rules.json").exists())  # rules stay at "approval"

    def test_from_is_required_and_account_checked(self):
        self.assertEqual(self.run_script("--profiles", "alice").returncode, 2)
        self.assertEqual(self.run_script("--profiles", "alice", "--from", "a@b.co", "--account", "x;rm").returncode, 2)

    def test_uninstall(self):
        self.run_script("--profiles", "alice", "--from", "a@b.co", "--account", "contact", "--apply")
        done = self.run_script("--profiles", "alice", "--uninstall", "--apply")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertFalse((self.root / "profiles" / "alice" / "plugins" / "email-drafts").exists())
        self.assertIn("plugins disable email-drafts", self.log.read_text())


if __name__ == "__main__":
    unittest.main()
