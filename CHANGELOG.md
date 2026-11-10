# Changelog

Notable changes to HermesBot. The project follows [semantic versioning](https://semver.org) from 1.0.0 on; before that, any release may change behavior.

## Unreleased

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
