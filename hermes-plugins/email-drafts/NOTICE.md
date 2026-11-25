# NOTICE

This plugin comes from **Hermes Bot Kit** by Thomas Bekkers,
https://github.com/thomasbek3/hermes-bot-kit (release v2026.11.24.1, folder
`email-drafts/`), under the MIT License (full text in `LICENSE`, a copy of
`../LICENSE-hermes-bot-kit`).

Changes for HermesBot (2026-11-25):

- The Composio sender (`composio_sender.py` and its tests) is removed.
- New default sender **himalaya** (`senders.send_himalaya`, settings
  `himalaya_account`, `himalaya_sent_folder`, `himalaya_cli`), the mail CLI
  HermesBot already uses; Gmail (own OAuth) and SMTP stay as options.
- `list` with a `session_id` returns that chat's drafts in the card view, and
  the view carries `session_id` (HermesBot shows one chat's drafts as cards).
- Wording: "HermesBot" instead of the upstream desktop product names.
- New `install.sh` (named profiles only, dry run unless `--apply`, backs up
  `config.yaml`), new tests `tests/test_himalaya_sender.py`.
