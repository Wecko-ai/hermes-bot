# Changelog

Notable changes to HermesBot. The project follows [semantic versioning](https://semver.org) from 1.0.0 on; before that, any release may change behavior.

## Unreleased

- Dictation that works in the desktop app: the microphone button uses the speech recognition of macOS through a small native helper (on the device when the language allows it, never through HermesBot's server). While it listens, a pill shows a stop button, a timer and the microphone level; Stop keeps the text to edit, Send sends at once. The old button relied on a browser API that cannot work in Electron.
- The microphone can only be opened by a real click or key press in the window, in front, for two minutes at most; a page served by another copy of the app has to be allowed once.
- Send button in black and white, flat; the stop-the-turn button shows a music-style pause.
- Loading screen: the logo beats like a heart with "Loading…" under it, instead of a progress bar; the logo no longer shows a light rim.
- New bot: the "+" at the top of the roster creates a bot (name, colour, shape). Its chat opens at once and the bot introduces itself and asks for its role.
- Right-click menu on a bot: pin, move to a section, mark as read, rename, copy the conversation ID, hide, delete. Delete takes the bot out of the roster and keeps its Hermes profile.
- Questions a bot lists at the end of its latest reply become a form even without an "Open questions" heading: one field per question, all answers sent in one turn.
- Search in the conversation works like find-in-page: the whole thread stays in view, matches are highlighted, Enter and Shift+Enter move between them, the counter shows the position.
- Links in a bot's message open in the default browser, `http://` and `mailto:` included; an address written without its scheme gets `https://`.
- macOS notifications: optional ad hoc code signature of the package (`HERMESBOT_MAC_SIGN=adhoc`), without which macOS drops every notification; the end of a turn in the open chat is now notified when the window is in the background; statuses keep being read while the window is hidden and a bot works; "Test notification" button in Settings.
- The jump-to-latest button is a round arrow that goes to the end of the conversation instantly.
- A cleaner main view: no hint text under the composer (a chat guide in Settings > Chats replaces it), the details panel stays closed until asked, the theme switch lives in Settings only, and a working bot no longer has a spinning ring.
- A notification for a finished turn shows only the bot's message under its name, without "Is done".
- Choosing a bot gives the keyboard to its message field, even while its conversation loads: typing right away writes to it.
- Larger, easier to read controls: the composer bar (modes, sending choice, context, model) and the details panel (tabs on one line, Activity entries as cards whose time never wraps, the bot's steps in plain text).
- One message per turn: while a bot works, the thread shows a single line, its live avatar and a caption swept by a sheen (its current step, tool or task), instead of a bubble for every step. The steps a bot writes before its tool calls fold out of the thread into the Activity tab; a step that carries a file or a mail card stays. The reply appears whole when the turn ends. The local chat still streams its replies.
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
