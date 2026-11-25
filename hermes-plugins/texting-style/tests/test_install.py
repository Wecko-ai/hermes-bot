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
        done = self.run_script("--profiles", "alice")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("dry run", done.stdout)
        self.assertFalse((self.root / "profiles" / "alice" / "plugins").exists())
        self.assertFalse(self.log.exists())

    def test_apply_installs_enables_and_backs_up(self):
        done = self.run_script("--profiles", "alice", "--apply")
        self.assertEqual(done.returncode, 0, done.stderr)
        home = self.root / "profiles" / "alice"
        self.assertTrue((home / "plugins" / "texting-style" / "__init__.py").is_file())
        self.assertTrue(any(p.name.startswith("config.yaml.bak-texting-style-") for p in home.iterdir()))
        self.assertIn("--profile alice plugins enable texting-style", self.log.read_text())

    def test_uninstall(self):
        self.run_script("--profiles", "alice", "--apply")
        done = self.run_script("--profiles", "alice", "--uninstall", "--apply")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertFalse((self.root / "profiles" / "alice" / "plugins" / "texting-style").exists())
        self.assertIn("plugins disable texting-style", self.log.read_text())


if __name__ == "__main__":
    unittest.main()
