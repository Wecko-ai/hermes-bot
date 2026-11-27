"""Hand a draft to its sender: himalaya (the default), Gmail or SMTP.

Adapted for HermesBot from hermes-bot-kit (MIT, Thomas Bekkers; see NOTICE.md).
The Composio sender of the kit is removed. HermesBot's mail engine is the
``himalaya`` CLI already configured on the bot's machine (the same one the
``mail-approval`` skill uses): the MIME message goes in on stdin, never on the
command line, with no shell, a minimal environment and a time limit.

Gmail goes through Hermes: ``credentialed_provider_request("google", ...)``
attaches the token from the user's own OAuth client declared under ``oauth:``
in plugin.yaml (``hermes auth add email-drafts:google``). The plugin never sees,
stores or refreshes the token.

SMTP reads its password with ``agent.secret_scope.get_secret`` (the profile's
secret scope), and only over TLS (STARTTLS or implicit SSL).

Gmail and SMTP are looked up through ``SENDERS`` so tests swap in fakes.
"""

from __future__ import annotations

import base64
import os
import re
from pathlib import Path
import shutil
import subprocess
import mimetypes
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid
from typing import Any, Callable

from .store import DraftError

GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
SEND_TIMEOUT_S = 60.0


DEFAULT_SENDER = "himalaya"
SENDER_NAMES = ("himalaya", "gmail", "smtp")
HIMALAYA_CANDIDATES = ("/opt/homebrew/bin/himalaya", "/usr/local/bin/himalaya")


class SendError(Exception):
    """The backend refused or failed; nothing was sent. The text is safe to show."""


class DeliveryUnknown(Exception):
    """The backend may or may not have sent it (a timeout mid-send). The draft
    is marked delivery-unknown and never retried. The text is safe to show."""


def signed_body(body: str, signature: str) -> str:
    """The body with the signature under it (once: a body that already ends
    with the signature is left alone)."""
    text = (body or "").rstrip()
    sig = (signature or "").replace("\\n", "\n").strip()
    if not sig or text.endswith(sig):
        return text + "\n"
    return f"{text}\n\n{sig}\n"


def build_message(draft: dict, settings: dict, attachments: list[dict]) -> EmailMessage:
    from_address = str(settings.get("from_address") or "").strip()
    if not from_address:
        raise SendError("No From address is set for this bot (email-drafts setting from_address in the bot profile)")
    msg = EmailMessage()
    name = str(settings.get("from_name") or "").strip()
    msg["From"] = formataddr((name, from_address)) if name else from_address
    if draft.get("to"):
        msg["To"] = ", ".join(draft["to"])
    if draft.get("cc"):
        msg["Cc"] = ", ".join(draft["cc"])
    if draft.get("bcc"):
        msg["Bcc"] = ", ".join(draft["bcc"])
    msg["Subject"] = draft.get("subject") or ""
    msg["Date"] = formatdate(localtime=True)
    domain = from_address.rsplit("@", 1)[-1]
    msg["Message-ID"] = make_msgid(domain=domain)
    reply = draft.get("in_reply_to") or {}
    if reply.get("message_id"):
        msg["In-Reply-To"] = reply["message_id"]
        refs = [r for r in (reply.get("references") or []) if r]
        if reply["message_id"] not in refs:
            refs.append(reply["message_id"])
        msg["References"] = " ".join(refs)
    msg.set_content(signed_body(draft.get("body") or "", str(settings.get("signature") or "")))
    for item in attachments:
        ctype, encoding = mimetypes.guess_type(item["name"])
        if ctype is None or encoding is not None:
            ctype = "application/octet-stream"
        maintype, subtype = ctype.split("/", 1)
        with open(item["path"], "rb") as handle:
            msg.add_attachment(handle.read(), maintype=maintype, subtype=subtype, filename=item["name"])
    return msg


def all_recipients(draft: dict) -> list[str]:
    return [*draft.get("to", []), *draft.get("cc", []), *draft.get("bcc", [])]


def _provider_request() -> Callable[..., Any]:
    from hermes_cli.plugin_provider_requests import credentialed_provider_request

    return credentialed_provider_request


def send_gmail(msg: EmailMessage, draft: dict, settings: dict, *, request: Callable[..., Any] | None = None) -> dict:
    """POST users/me/messages/send with the raw message (Bcc is honoured and
    stripped by Gmail). Threads into ``in_reply_to.thread_id`` when known."""
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode("ascii")
    payload: dict[str, Any] = {"raw": raw}
    thread_id = str((draft.get("in_reply_to") or {}).get("thread_id") or "").strip()
    if thread_id:
        payload["threadId"] = thread_id
    call = request or _provider_request()
    try:
        resp = call("google", "POST", GMAIL_SEND_URL, json=payload, timeout=SEND_TIMEOUT_S)
    except PermissionError as exc:
        raise SendError(f"Gmail is not available to this plugin: {exc}") from None
    except Exception as exc:  # ProviderNotSignedIn, AuthError, network errors
        name = type(exc).__name__
        if name == "ProviderNotSignedIn":
            raise SendError(f"Gmail is not signed in: {exc}") from None
        code = getattr(exc, "code", "")
        raise SendError(f"Gmail send failed ({code or name}): {exc}") from None
    status = int(getattr(resp, "status", 0) or 0)
    if status >= 300 or status < 200:
        text = ""
        try:
            text = str(resp.text)[:300]
        except Exception:
            pass
        raise SendError(f"Gmail refused the message ({status}): {text}")
    try:
        body = resp.json() or {}
    except Exception:
        body = {}
    return {"backend": "gmail", "message_id": msg["Message-ID"], "gmail_id": body.get("id"), "thread_id": body.get("threadId")}


def _secret(name: str) -> str:
    from agent.secret_scope import get_secret

    return get_secret(name) or ""


SMTP_CLASSES: dict[str, Any] = {"starttls": smtplib.SMTP, "ssl": smtplib.SMTP_SSL}


def send_smtp(msg: EmailMessage, draft: dict, settings: dict, *, secret: Callable[[str], str] | None = None) -> dict:
    host = str(settings.get("smtp_host") or "").strip()
    if not host:
        raise SendError("No SMTP host is set for this bot (email-drafts setting smtp_host in the bot profile)")
    security = str(settings.get("smtp_security") or "starttls")
    if security not in SMTP_CLASSES:
        raise SendError(f"SMTP security must be starttls or ssl, not {security!r}")
    port = int(settings.get("smtp_port") or (465 if security == "ssl" else 587))
    username = str(settings.get("smtp_username") or "").strip()
    password = (secret or _secret)("EMAIL_DRAFTS_SMTP_PASSWORD") if username else ""
    if username and not password:
        raise SendError("The SMTP password is not set (secret EMAIL_DRAFTS_SMTP_PASSWORD of the bot profile)")
    context = ssl.create_default_context()
    recipients = all_recipients(draft)
    try:
        if security == "ssl":
            client = SMTP_CLASSES["ssl"](host, port, timeout=SEND_TIMEOUT_S, context=context)
        else:
            client = SMTP_CLASSES["starttls"](host, port, timeout=SEND_TIMEOUT_S)
        with client:
            if security == "starttls":
                client.starttls(context=context)
            if username:
                client.login(username, password)
            refused = client.send_message(msg, from_addr=str(settings.get("from_address")), to_addrs=recipients)
    except smtplib.SMTPAuthenticationError:
        raise SendError("SMTP sign-in failed: check the username and password") from None
    except (smtplib.SMTPException, OSError) as exc:
        raise SendError(f"SMTP send failed: {type(exc).__name__}: {exc}") from None
    if refused and len(refused) >= len(recipients):
        raise SendError("The SMTP server refused every recipient")
    return {"backend": "smtp", "message_id": msg["Message-ID"], "refused": sorted(refused or {})}


def himalaya_path(settings: dict) -> str:
    configured = str(settings.get("himalaya_cli") or "").strip()
    if configured:
        if not os.path.isabs(configured) or not os.access(configured, os.X_OK):
            raise SendError("The himalaya path must be an absolute path to an executable")
        return configured
    found = shutil.which("himalaya")
    if found:
        return found
    for candidate in HIMALAYA_CANDIDATES:
        if os.access(candidate, os.X_OK):
            return candidate
    raise SendError("himalaya is not installed on the bot's machine (brew install himalaya)")


def _himalaya_env() -> dict:
    keep = ("HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "TMPDIR", "HIMALAYA_CONFIG")
    env = {key: os.environ[key] for key in keep if key in os.environ}
    env.setdefault("PATH", "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin")
    return env


RUN: Callable[..., Any] = subprocess.run


def send_himalaya(msg: EmailMessage, draft: dict, settings: dict, *, run: Callable[..., Any] | None = None) -> dict:
    """``himalaya [-a account] message send [--save box | --no-save]`` with the raw message on stdin.

    A refusal before the hand-over (bad config, auth, a refused recipient) exits non-zero with
    nothing sent: SendError, Retry allowed. A timeout or a crash may have sent it: DeliveryUnknown."""
    cli = himalaya_path(settings)
    args = [cli]
    account = str(settings.get("himalaya_account") or "").strip()
    if account:
        if not all(ch.isalnum() or ch in "-_." for ch in account):
            raise SendError("The himalaya account name has characters it cannot have")
        args += ["--account", account]
    args += ["message", "send"]
    sent_folder = str(settings.get("himalaya_sent_folder") or "").strip()
    args += ["--save", sent_folder] if sent_folder else ["--no-save"]
    try:
        done = (run or RUN)(args, input=msg.as_bytes(), capture_output=True, timeout=SEND_TIMEOUT_S, env=_himalaya_env(), check=False)
    except subprocess.TimeoutExpired:
        raise DeliveryUnknown("himalaya did not answer in time: check your Sent folder before trying again") from None
    except OSError as exc:
        raise SendError(f"himalaya could not start: {exc}") from None
    if done.returncode < 0:
        raise DeliveryUnknown("himalaya stopped during the send: check your Sent folder before trying again")
    if done.returncode != 0:
        detail = (done.stderr or b"").decode("utf-8", "replace").strip().splitlines()
        tail = detail[-1][:300] if detail else f"exit {done.returncode}"
        raise SendError(f"himalaya refused the message: {tail}")
    return {"backend": "himalaya", "message_id": msg["Message-ID"]}



ADDRESS_IN_FROM = re.compile(r"(?:^|<)\s*([^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+)\s*>?\s*$")


def extract_email(value: str) -> str:
    """The address in `Name <a@b.co>` or a bare address, lowercased."""
    text = (value or "").replace("\r", " ").replace("\n", " ").strip()
    if not text:
        return ""
    match = ADDRESS_IN_FROM.search(text)
    return (match.group(1) if match else text).strip().lower()


def _himalaya_config_path() -> Path:
    override = os.environ.get("HIMALAYA_CONFIG") or os.environ.get("EMAIL_DRAFTS_HIMALAYA_CONFIG")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".config" / "himalaya" / "config.toml"


def list_himalaya_accounts(config_path: str | Path | None = None) -> list[dict[str, str]]:
    """Account name, email and display name from himalaya's config. Passwords and
    command settings are ignored: only ``email`` / ``display-name`` / the table name."""
    path = Path(config_path) if config_path else _himalaya_config_path()
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return []
    accounts: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    header = re.compile(r"^\s*\[accounts\.([A-Za-z0-9_.-]+)\]\s*$")
    field = re.compile(r"^\s*(email|display-name|display_name)\s*=\s*(.*)$", re.I)
    for line in text.splitlines():
        start = header.match(line)
        if start:
            current = {"name": start.group(1), "email": "", "from_name": ""}
            accounts.append(current)
            continue
        if current is None:
            continue
        match = field.match(line)
        if not match:
            continue
        key, raw = match.group(1).lower(), match.group(2).strip()
        if len(raw) < 2 or raw[0] != raw[-1] or raw[0] not in {'"', "'"}:
            continue
        value = raw[1:-1]
        if key == "email":
            current["email"] = value.strip()
        else:
            current["from_name"] = value.strip()
    return [item for item in accounts if item["name"]]


def resolve_sender(settings: dict, from_header: str = "", *, accounts: list[dict[str, str]] | None = None) -> dict:
    """Pick the himalaya account that matches the draft's From, else the profile default.

    ``himalaya_accounts`` on the profile is an allow-list of account names. Empty:
    any account in the himalaya config may be used when From matches its email.
    """
    resolved = dict(settings)
    allowed_raw = settings.get("himalaya_accounts") or []
    if isinstance(allowed_raw, str):
        allowed = [part.strip() for part in allowed_raw.split(",") if part.strip()]
    elif isinstance(allowed_raw, list):
        allowed = [str(part).strip() for part in allowed_raw if str(part).strip()]
    else:
        allowed = []
    known = accounts if accounts is not None else list_himalaya_accounts()
    email = extract_email(from_header) or extract_email(str(settings.get("from_address") or ""))
    match = next((item for item in known if extract_email(item.get("email") or "") == email), None) if email else None
    if match is not None and allowed and match["name"] not in allowed:
        raise SendError(
            f"This bot cannot send as {email}: its allowed himalaya accounts are {', '.join(allowed)}"
        )
    if match is None and settings.get("himalaya_account"):
        want = str(settings.get("himalaya_account")).strip()
        if allowed and want not in allowed:
            want = ""
        if want:
            match = next((item for item in known if item["name"] == want), None)
            if match is None:
                match = {"name": want, "email": str(settings.get("from_address") or ""), "from_name": str(settings.get("from_name") or "")}
    if match is not None:
        resolved["himalaya_account"] = match["name"]
        resolved["from_address"] = (
            extract_email(from_header) or extract_email(match.get("email") or "") or str(settings.get("from_address") or "")
        )
        header_name = from_header.split("<", 1)[0].strip().strip('"') if from_header and "<" in from_header else ""
        resolved["from_name"] = header_name or str(resolved.get("from_name") or "") or match.get("from_name") or ""
        return resolved
    if from_header and extract_email(from_header):
        # No matching account: keep the profile default account, but refuse a From
        # that does not belong to it if an allow-list is set.
        if allowed and email and extract_email(str(settings.get("from_address") or "")) != email:
            raise SendError(
                f"This bot cannot send as {email}: its allowed himalaya accounts are {', '.join(allowed)}"
            )
    return resolved


SENDERS: dict[str, Callable[..., dict]] = {"himalaya": send_himalaya, "gmail": send_gmail, "smtp": send_smtp}


def deliver(draft: dict, settings: dict, attachments: list[dict]) -> dict:
    backend = str(settings.get("sender") or DEFAULT_SENDER)
    if backend not in SENDER_NAMES:
        raise SendError(f"Unknown sender {backend!r} (himalaya, gmail or smtp)")
    if not draft.get("to"):
        raise DraftError("Add at least one To address")
    settings = resolve_sender(settings, str(draft.get("from") or ""))
    sender = SENDERS[backend]
    msg = build_message(draft, settings, attachments)
    return sender(msg, draft, settings)
