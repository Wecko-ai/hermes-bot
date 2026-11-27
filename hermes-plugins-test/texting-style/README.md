# texting-style (agent plugin, per profile)

From [Hermes Bot Kit](https://github.com/thomasbek3/hermes-bot-kit) (MIT,
see [NOTICE.md](NOTICE.md)), adapted for HermesBot.

Makes a bot answer like a text message in its **Bot Chat only** (the
per-bot conversation HermesBot opens, titled `Bot Chat`): one or two short
sentences by default, the user's length mirrored, no headings or lists, a
quick acknowledgement before real work, long answers only when asked or when
the deliverable is long. Files, code, mails, posts and messages to other bots
keep their normal form. Other sessions of the profile (crons, work sessions,
Telegram unless allowed) are untouched. No tools, no network.

This is the per-profile, permanent cousin of HermesBot's **caveman** setting
(a note added to one turn, for every bot). Use one or the other per bot.

## Install (named profiles only)

```bash
bash hermes-plugins/texting-style/install.sh --profiles alice,orion            # dry run, prints the steps
bash hermes-plugins/texting-style/install.sh --profiles alice,orion --apply    # copy + enable, config.yaml backed up
bash hermes-plugins/texting-style/install.sh --profiles alice --uninstall --apply
```

The profile's agent loads it the next time it reloads its plugins (a gateway
restart). Existing Bot Chats get it on their next message through the
`pre_llm_call` backfill hook (their system prompt is frozen).

## Config (`plugins.entries.texting-style.settings` in the profile)

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. |
| `bot_chat_only` | `true` | Only the session titled `Bot Chat`. `false` = every session of the profile. |
| `platforms` | `""` | Comma-separated allowlist (empty = all). |
| `extra_rules` | `""` | One extra rule appended to the doctrine. |

Tests: `python3 -m unittest discover -s hermes-plugins/texting-style/tests -p 'test_*.py'`.
Debug: `TS_DEBUG=1` logs each decision to `<HERMES_HOME>/logs/texting-style-debug.log`.
