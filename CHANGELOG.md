# Changelog

Notable changes to HermesBot. The project follows [semantic versioning](https://semver.org) from 1.0.0 on; before that, any release may change behavior.

## Unreleased

- Model picker: before a conversation switches model, HermesBot asks the gateway whether that provider can serve the bot (`setup.runtime_check`, no model call). A provider with no usable key shows "No key" in the picker, and choosing it asks first, with the gateway's reason. Without the check, the next turn failed before reaching the model.
- "Standing by" status: a bot with no turn but with subagents or background processes still running gets a calm ring and its own label; hovering it says how many. "Working" keeps the priority.
- Subagents block in the chat, read only: goal, status, duration, last tool and final summary of each delegated child, and the end of its live transcript on click.
- Caveman mode (Settings > Conversations): bots answer in few words, with the same facts. Off by default. Only their chat replies change; an approved mail goes out with nothing added.
- Sign-in without a password to a Hermes on the same Mac, its default setup: the desktop app signs in by itself, and `npm run dev` prints a sign-in link. The Hermes session token stays in the server and only goes to the gateway that owns the Hermes home.
- `AGENT-INSTALL.md`: an installation guide written for an agent. It builds the app, tries the demo and checks whether HermesBot can sign in to your Hermes.
- The demo (`?demo=1`) follows the interface language.
- README, comments and bot skills in English.

## 0.2.0

First version of the public repository.

- Roster by group or by activity, live status of every bot, one-line summary of the current work.
- Bot Chat with streaming, Markdown, file drop, search, drafts kept per bot.
- Questions asked mid-turn, approvals, and the Hermes credential prompt.
- Wait, Queue and Priority sending while a bot works.
- Bot media (galleries, video, audio, viewer), files cited by path, PDF, HTML and Markdown documents in tabs.
- Bot-to-bot message lines and `@bot` mentions.
- BRAIN, PLAN and EXEC modes, model picker per conversation, Usage tab.
- Read-only routines, technical activity apart from the chat.
- Optional: local chat with Ollama, bot animations, mail approval card, vault for a shared Chrome.
- Interface in English and French, light and dark themes.
- Settings from environment variables or `config.json`.
