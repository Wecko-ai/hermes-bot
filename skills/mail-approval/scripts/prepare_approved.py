#!/usr/bin/env python3
"""Prepare the .eml of a mail approved in HermesBot. Sends nothing.

Refuses if the content no longer matches the digest computed at the time of the click, or if this
mail was already prepared: an existing output file prevents a second send.
"""
import argparse
import hashlib
import sys
import unicodedata
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from email.utils import formatdate, make_msgid, parseaddr
from pathlib import Path


def fail(message: str) -> None:
    print(f"REFUSED: {message}. Nothing was prepared.", file=sys.stderr)
    sys.exit(2)


def parse_approved(text: str) -> tuple[dict[str, str], str]:
    head, separator, body = text.replace("\r\n", "\n").lstrip("\n").partition("\n\n")
    if not separator:
        fail("approved block without a body")
    headers = {}
    for line in head.split("\n"):
        name, colon, value = line.partition(":")
        if colon:
            headers[name.strip().lower()] = value.strip()
    return headers, body.rstrip()


def digest(headers: dict[str, str], body: str) -> str:
    fields = [headers.get(name, "") for name in ("from", "draft-id", "to", "cc", "subject")]
    canonical = "\n".join([*fields, body])
    return hashlib.sha256(unicodedata.normalize("NFC", canonical).encode("utf-8")).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--approved", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--draft", type=Path)
    args = parser.parse_args()

    if args.out.exists():
        fail(f"{args.out} already exists, this mail may already have been sent")
    headers, body = parse_approved(args.approved.read_text(encoding="utf-8"))
    expected = headers.get("approved-digest", "")
    if not expected:
        fail("Approved-Digest is missing")
    if digest(headers, body) != expected:
        fail("the content does not match what was approved")
    if not headers.get("to"):
        fail("no recipient")

    sender = headers.get("from", "")
    address = parseaddr(sender)[1]
    if not address:
        fail("no sender")
    if headers.get("draft-id") and not args.draft:
        fail("this mail carries a Draft-Id: --draft is required")

    # Allowlist: only the displayed and approved fields go out, plus the thread headers.
    # A Bcc, Reply-To or Resent-* slipped into the draft therefore never gets through.
    message = EmailMessage(policy=policy.SMTP)
    message["From"] = sender
    message["To"] = headers["to"]
    if headers.get("cc"):
        message["Cc"] = headers["cc"]
    message["Subject"] = headers.get("subject", "")
    message["Date"] = formatdate(usegmt=True)
    message["Message-ID"] = make_msgid(domain=address.rpartition("@")[2])
    if args.draft:
        draft = BytesParser(policy=policy.SMTP).parsebytes(args.draft.read_bytes())
        if parseaddr(str(draft["From"] or ""))[1].lower() != address.lower():
            fail("the draft does not come from the approved sender")
        for name in ("In-Reply-To", "References"):
            if draft[name]:
                message[name] = str(draft[name])
    message.set_content(body + "\n", charset="utf-8")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(message.as_bytes(policy=policy.SMTP))
    print(f"Ready: {args.out}")


if __name__ == "__main__":
    main()
