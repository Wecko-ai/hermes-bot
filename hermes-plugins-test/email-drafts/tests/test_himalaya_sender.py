"""HermesBot's himalaya sender (no real mail: subprocess.run is faked).

    python3 -m unittest discover -s email-drafts/tests -p 'test_*.py'
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
import unittest
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parents[1]


def _load():
    name = "email_drafts_himalaya_test"
    spec = importlib.util.spec_from_file_location(name, PLUGIN_DIR / "__init__.py", submodule_search_locations=[str(PLUGIN_DIR)])
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return sys.modules[f"{name}.senders"]


senders = _load()

DRAFT = {"to": ["sam@example.com"], "cc": ["kim@example.com"], "bcc": [], "subject": "Hello", "body": "Hi Sam"}
SETTINGS = {"from_address": "me@example.com", "himalaya_cli": sys.executable}


class Done:
    def __init__(self, code=0, stderr=b""):
        self.returncode = code
        self.stderr = stderr
        self.stdout = b""


class HimalayaSenderTest(unittest.TestCase):
    def test_default_sender_is_himalaya_and_composio_is_gone(self):
        self.assertEqual(senders.DEFAULT_SENDER, "himalaya")
        self.assertNotIn("composio", senders.SENDER_NAMES)

    def test_message_goes_on_stdin_never_on_the_command_line(self):
        calls = []

        def run(args, **kwargs):
            calls.append((args, kwargs))
            return Done()

        msg = senders.build_message(DRAFT, SETTINGS, [])
        receipt = senders.send_himalaya(msg, DRAFT, {**SETTINGS, "himalaya_account": "contact"}, run=run)
        self.assertEqual(receipt["backend"], "himalaya")
        args, kwargs = calls[0]
        self.assertEqual(args[1:], ["--account", "contact", "message", "send", "--no-save"])
        self.assertIn(b"Subject: Hello", kwargs["input"])
        self.assertNotIn("Hi Sam", " ".join(args))
        self.assertNotIn("shell", kwargs)
        self.assertNotIn("EMAIL_DRAFTS_SMTP_PASSWORD", kwargs["env"])

    def test_sent_folder_is_saved_when_set(self):
        seen = []
        msg = senders.build_message(DRAFT, SETTINGS, [])
        senders.send_himalaya(msg, DRAFT, {**SETTINGS, "himalaya_sent_folder": "Sent"}, run=lambda args, **kw: seen.append(args) or Done())
        self.assertEqual(seen[0][-2:], ["--save", "Sent"])

    def test_refusal_is_a_send_error_with_retry(self):
        msg = senders.build_message(DRAFT, SETTINGS, [])
        with self.assertRaises(senders.SendError) as caught:
            senders.send_himalaya(msg, DRAFT, SETTINGS, run=lambda *a, **k: Done(1, b"warn\nerror: 550 recipient refused"))
        self.assertIn("550 recipient refused", str(caught.exception))

    def test_timeout_or_crash_is_delivery_unknown(self):
        msg = senders.build_message(DRAFT, SETTINGS, [])

        def slow(*a, **k):
            raise subprocess.TimeoutExpired("himalaya", 60)

        with self.assertRaises(senders.DeliveryUnknown):
            senders.send_himalaya(msg, DRAFT, SETTINGS, run=slow)
        with self.assertRaises(senders.DeliveryUnknown):
            senders.send_himalaya(msg, DRAFT, SETTINGS, run=lambda *a, **k: Done(-9))

    def test_bad_account_or_path_is_refused_before_running(self):
        msg = senders.build_message(DRAFT, SETTINGS, [])
        with self.assertRaises(senders.SendError):
            senders.send_himalaya(msg, DRAFT, {**SETTINGS, "himalaya_account": "a;rm -rf"}, run=lambda *a, **k: Done())
        with self.assertRaises(senders.SendError):
            senders.send_himalaya(msg, DRAFT, {**SETTINGS, "himalaya_cli": "himalaya"}, run=lambda *a, **k: Done())


if __name__ == "__main__":
    unittest.main()

class ResolveSender(unittest.TestCase):
    ACCOUNTS = [
        {"name": "work", "email": "alex@example.com", "from_name": "Alex Rivera"},
        {"name": "contact", "email": "contact@example.com", "from_name": "Team"},
        {"name": "personal", "email": "alex@example.org", "from_name": "Alex"},
    ]

    def test_from_picks_matching_himalaya_account(self):
        settings = {"from_address": "contact@example.com", "himalaya_account": "contact", "from_name": "Team"}
        resolved = senders.resolve_sender(
            settings, "Alex Rivera <alex@example.com>", accounts=self.ACCOUNTS,
        )
        self.assertEqual(resolved["himalaya_account"], "work")
        self.assertEqual(resolved["from_address"], "alex@example.com")
        self.assertEqual(resolved["from_name"], "Alex Rivera")

    def test_allow_list_blocks_another_account(self):
        settings = {
            "from_address": "alex@example.com",
            "himalaya_account": "work",
            "himalaya_accounts": ["work"],
        }
        with self.assertRaises(senders.SendError):
            senders.resolve_sender(settings, "Team <contact@example.com>", accounts=self.ACCOUNTS)

    def test_default_account_when_from_is_empty(self):
        settings = {"from_address": "alex@example.com", "himalaya_account": "work", "from_name": ""}
        resolved = senders.resolve_sender(settings, "", accounts=self.ACCOUNTS)
        self.assertEqual(resolved["himalaya_account"], "work")
        self.assertEqual(resolved["from_address"], "alex@example.com")

    def test_list_himalaya_accounts_reads_only_email_and_name(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "config.toml"
            path.write_text(
                "[accounts.work]\n"
                "email = \"alex@example.com\"\n"
                "display-name = \"Alex Rivera\"\n"
                "password = \"should-not-be-read\"\n"
                "[accounts.contact]\n"
                "email = \"contact@example.com\"\n"
            )
            rows = senders.list_himalaya_accounts(path)
        self.assertEqual(
            rows,
            [
                {"name": "work", "email": "alex@example.com", "from_name": "Alex Rivera"},
                {"name": "contact", "email": "contact@example.com", "from_name": ""},
            ],
        )
        self.assertTrue(all("password" not in row and "pass" not in "".join(row.values()) for row in rows))
