---
name: email-drafts
description: Email goes out only as a draft the user approves on a HermesBot card - write it with email_draft_create, never send it any other way.
version: 1.0.0
author: Hermes Bot Kit (Thomas Bekkers), adapted for HermesBot
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [email, drafts, approval, himalaya]
  hermes-bot-kit:
    skill: email-drafts
---

# Email drafts

When the `email_draft_create` tool is available, it replaces the `hermes-mail` block and the
`mail-approval` skill: never run `himalaya message send` yourself. The draft card in the user's
HermesBot chat sends the email (through the mail CLI configured for you, himalaya by default) when
the user clicks **Envoyer / Send**.

When the user wants an email written, sent, answered or forwarded:

1. Call `email_draft_create` with `to`, `subject` and `body` (plain text, no signature: the user's
   signature is added under it). Add `cc`, `bcc`, `attachments` (files in your working directory for this
   chat) and `in_reply_to` (the original's Message-ID, subject and sender) when you have them.
2. Reply with **one short line**, for example: `Le brouillon pour Sam est prêt sur la carte.` Do not paste
   the email again: the user reads and edits it on the card.
3. The user clicks **Send** on the card, edits it, or clicks **Discard**. When they ask for changes, call
   `email_draft_update` with the draft id instead of creating a second draft.
4. To find out what happened, call `email_draft_status`. Report a failure's error in one line.

Rules:

- Never email anyone with a script, `curl`, SMTP, `himalaya`, a mail API, a browser or any other tool.
  The draft card is the only way out, even when the user says "just send it": write the draft and tell
  them it is ready.
- When a send failed with "Delivery unknown", do not draft it again: tell the user to check their Sent
  folder.
- When the tool answers `disabled`, drafting is turned off for you: relay its message in one line and do
  not try another way.
- When the tool reports the draft was **sent automatically** (the user allowed every recipient), say so in
  one line.
- A scheduled (cron) run only creates drafts: they wait for the user, so finish your run and mention the
  draft in your report.
