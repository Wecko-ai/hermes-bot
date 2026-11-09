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
from email.utils import formatdate, make_msgid, parseaddr
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
        fail(f"{args.out} existe déjà, ce mail a peut-être été envoyé")
    headers, body = parse_approved(args.approved.read_text(encoding="utf-8"))
    expected = headers.get("approved-digest", "")
    if not expected:
        fail("empreinte Approved-Digest absente")
    if digest(headers, body) != expected:
        fail("le contenu ne correspond pas à ce qui a été approuvé")
    if not headers.get("to"):
        fail("aucun destinataire")

    sender = headers.get("from", "")
    address = parseaddr(sender)[1]
    if not address:
        fail("aucun expéditeur")
    if headers.get("draft-id") and not args.draft:
        fail("ce mail porte un Draft-Id : --draft est obligatoire")

    # Liste blanche : seuls les champs affichés et approuvés partent, plus le fil de discussion.
    # Un Bcc, un Reply-To ou un Resent-* glissé dans le brouillon ne passe donc jamais.
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
            fail("le brouillon ne vient pas de l'expéditeur approuvé")
        for name in ("In-Reply-To", "References"):
            if draft[name]:
                message[name] = str(draft[name])
    message.set_content(body + "\n", charset="utf-8")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(message.as_bytes(policy=policy.SMTP))
    print(f"Prêt : {args.out}")


if __name__ == "__main__":
    main()
