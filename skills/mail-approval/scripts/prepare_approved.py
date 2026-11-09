#!/usr/bin/env python3
"""Prépare le .eml d'un mail approuvé dans HermesBot. N'envoie rien.

Refuse si le contenu ne correspond plus à l'empreinte calculée au moment du clic, ou si ce mail
a déjà été préparé : le fichier de sortie existant empêche un second envoi.
"""
import argparse
import hashlib
import sys
import unicodedata
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from pathlib import Path


def fail(message: str) -> None:
    print(f"REFUSÉ : {message}. Rien n'a été préparé.", file=sys.stderr)
    sys.exit(2)


def parse_approved(text: str) -> tuple[dict[str, str], str]:
    head, separator, body = text.replace("\r\n", "\n").lstrip("\n").partition("\n\n")
    if not separator:
        fail("bloc approuvé sans corps")
    headers = {}
    for line in head.split("\n"):
        name, colon, value = line.partition(":")
        if colon:
            headers[name.strip().lower()] = value.strip()
    return headers, body.rstrip()


def digest(headers: dict[str, str], body: str) -> str:
    canonical = "\n".join([headers.get("to", ""), headers.get("cc", ""), headers.get("subject", ""), body])
    return hashlib.sha256(unicodedata.normalize("NFC", canonical).encode("utf-8")).hexdigest()


def replace_header(message: EmailMessage, name: str, value: str) -> None:
    del message[name]
    if value:
        message[name] = value


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--approved", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--draft", type=Path)
    args = parser.parse_args()

    if args.out.exists():
        fail(f"{args.out} existe déjà, ce mail a peut-être été envoyé")
    headers, body = parse_approved(args.approved.read_text(encoding="utf-8"))
    expected = headers.get("approved-digest", "")
    if not expected:
        fail("empreinte Approved-Digest absente")
    if digest(headers, body) != expected:
        fail("le contenu ne correspond pas à ce qui a été approuvé")
    if not headers.get("to"):
        fail("aucun destinataire")

    if args.draft:
        message = BytesParser(policy=policy.SMTP).parsebytes(args.draft.read_bytes())
    else:
        message = EmailMessage(policy=policy.SMTP)
        message["From"] = headers.get("from", "")
    if not message["From"]:
        fail("aucun expéditeur")
    replace_header(message, "To", headers["to"])
    replace_header(message, "Cc", headers.get("cc", ""))
    replace_header(message, "Subject", headers.get("subject", ""))
    message.set_content(body + "\n", charset="utf-8")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(message.as_bytes(policy=policy.SMTP))
    print(f"Prêt : {args.out}")


if __name__ == "__main__":
    main()
