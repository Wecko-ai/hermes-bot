<p align="center">
  <img src="docs/readme/hero.png" alt="HermesBot. Your agents. Your rules." width="100%" />
</p>

<p align="center">
  <b>One window for your whole team of <a href="https://github.com/NousResearch/hermes-agent">Hermes Agent</a> bots.</b><br />
  You own them. You pick the model. It runs on your machine.
</p>

<p align="center">
  <a href="#install-with-your-agent">Install with your agent</a> ·
  <a href="#try-it-without-hermes">Try the demo</a> ·
  <a href="#connect-it-to-hermes">Connect it to Hermes</a> ·
  <a href="https://x.com/i/status/2120164337008709910">Watch the film</a>
</p>

<p align="center">
  <a href="https://x.com/i/status/2120164337008709910"><img src="docs/readme/film-poster.png" alt="Watch the film, 60 seconds: one window, your whole team" width="100%" /></a><br />
  <sub>The film plays on X. The file is also in the repository: <a href="docs/readme/hermesbot-film.mp4">hermesbot-film.mp4</a>.</sub>
</p>

HermesBot is a desktop app for macOS. You see who is working, what each bot is doing and who is waiting for you, and you talk to each bot in its own chat. It is a client: your bots, their tools and their memory stay in Hermes, on your machine.

It is an independent project, not affiliated with Nous Research. Status: early (0.2), used daily by its author. The interface is in English and French.

## Yours, not rented

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/readme/own.png" alt="You own them: memories, skills, SOUL.md and config.yaml in the bot's own folder, on your machine" /><br />
      <b>You own your agents.</b> A bot is a Hermes profile: its memory, its skills and its files live in a folder on your disk. HermesBot is a window on them, nothing more.
    </td>
    <td width="50%" valign="top">
      <img src="docs/readme/models.png" alt="Pick your model: the model picker with Anthropic, OpenAI and Google Gemini, and a local model" /><br />
      <b>Pick your model.</b> Claude, GPT, Gemini, or a local model on your own GPU: any provider your Hermes is set up with. Change it for one conversation; the bot's profile is never rewritten.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/readme/machine.png" alt="Your machine: http://127.0.0.1:4330" /><br />
      <b>It runs on your machine.</b> The app's server listens on <code>127.0.0.1</code> only and talks to the Hermes gateway on your machine. Your provider keys stay in Hermes. HermesBot puts no cloud service in between.
    </td>
    <td width="50%" valign="top">
      <img src="docs/readme/open.png" alt="Open source: MIT license, free, yours to change" /><br />
      <b>Open source.</b> MIT license. Free. Yours to read and to change.
    </td>
  </tr>
</table>

## One window

![HermesBot in demo mode: a roster of bots by group, a chat, and the routines of the open bot](docs/screenshot.png)

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/readme/question.png" alt="A bot's question shown as a card above the input, with three choices" />
    </td>
    <td width="50%" valign="top">
      <b>See who needs you.</b> A bot that works is marked "Working", with one line on what it is doing. A bot that asks you something is marked "Waiting for your reply", and its question shows as a card: you answer in one click and it goes back to work.
    </td>
  </tr>
</table>

## Install with your agent

Give this message to an agent that can run shell commands on your Mac:

> Read https://raw.githubusercontent.com/Wecko-ai/hermes-bot/main/AGENT-INSTALL.md and follow it, step by step, to install HermesBot on this Mac.

[AGENT-INSTALL.md](AGENT-INSTALL.md) is written for the agent. It checks your Mac, builds the app, tries the demo and tells you whether HermesBot can sign in to your Hermes. It asks you before it touches your Hermes or your Applications folder, and it never handles your password.

## Try it without Hermes

You need Node.js 22 or later.

```bash
npm ci
npm run dev
```

Then open http://127.0.0.1:4330/?demo=1. The demo runs on fictional data and makes no network call.

## What it does

- **Roster.** Bots by group, or one list with the most recent activity first. Unread counts, search, a command palette (⌘K). Right-click a bot to pin it, move it to a section, mark it as read, rename it, copy its conversation ID, hide it or delete it.
- **New bot.** The "+" at the top of the roster creates a bot: a name, a colour and a shape. Its chat opens at once, and the bot introduces itself and asks what its role is.
- **Live status.** A bot that works is marked "Working", with a one-line summary of its current task, built from its to-do list and tool calls without any model call. A bot that asks you something is marked "Waiting for your reply". A bot with no turn but with subagents or background processes still running is marked "Standing by", with a calm ring and no animation; hovering it says how many are left. The status is right even for a bot woken by another bot.
- **Subagents.** In the chat, a collapsible "Subagents" block lists the children the bot delegated in that conversation: goal, status, duration, last tool and final summary. Click one to read the end of its live transcript. Read only: nothing there steers or stops a child. Standing by and this block need a Hermes gateway that answers `subagent.roster`, `process.list` and `subagent.list`; with an older one they stay empty.
- **Chat.** One message per turn: while a bot works, a single line with its live avatar says what it is doing, and its reply arrives whole. The steps it writes before its tool calls go to the Activity tab. Markdown, tables and code. Stop the current turn. Search in the conversation (⌘F): matches are highlighted and Enter goes from one to the next. Links open in your default browser. Drafts are kept per bot.
- **Questions and approvals.** A question a bot asks in the middle of a turn shows as a card above the input. Questions it lists at the end of a reply become a small form: one field under each question, and all your answers go back in one message. An action that needs approval opens a dialog (once, for the session, always, deny).
- **Sending while a bot works.** Wait (keeps your draft), Queue (runs after the current turn) or Priority (interrupts, then resumes).
- **Files.** Drag and drop images, videos, PDFs and other files into the chat.
- **Bot media.** Images, galleries, video and audio that a bot sends (`MEDIA:` lines) or cites by path show under its message, with a full-screen viewer. PDF, HTML and Markdown documents open in tabs next to the chat.
- **Bot-to-bot messages.** "Orion messaged Iris" lines in both chats, with the reply. `@bot` mentions tell a bot which other bot you mean.
- **Modes.** BRAIN (think with me), PLAN (write a plan) and EXEC (do it), per bot. BRAIN and PLAN are an instruction for one turn, not a lock on tools.
- **Caveman mode.** One switch in Settings > Conversations: every bot answers you in few words, with the same facts. It is a note read with each message you send, not a change to the bots' profiles. What a bot writes elsewhere (files, code, emails, posts, messages to other bots) keeps its normal style.
- **Model picker.** Change the model for one conversation. The bot's profile is never rewritten. Before switching, HermesBot asks Hermes whether that provider can serve the bot; a provider with no usable key is marked "No key".
- **Usage.** Context, tokens, cache, calls and speed for the conversation, and 30 days of tokens per day and per model.
- **Routines.** The scheduled jobs of each bot, read-only.
- **Credential prompt.** When a bot needs to log in to a site through the Hermes vault, a dialog asks you for the login or the code. The bot never sees the password.
- **Notifications.** A macOS notification when a bot finishes or asks you something, unless you are looking at its chat. macOS only delivers them from a signed build: see "Desktop app" below.
- **Settings.** Theme, text size, language, send key, notifications, hidden bots, which models the picker offers, and a short guide to the chat. They stay on your Mac. Managing a bot (create, rename, move, hide, delete) is the exception: it writes the bot's card in its Hermes profile, as Hermes Desktop does, so every app that reads the card agrees.

## Connect it to Hermes

HermesBot needs **Hermes Agent with its gateway Webapp on.** By default the gateway serves it on `http://127.0.0.1:9120`. See "Use the Desktop workspace from a browser" in the Hermes documentation (`hermes config set webapp.enabled true`, then `hermes gateway restart`).

It then signs in one of two ways, and picks the right one by itself:

- **Hermes on this Mac, without a password.** This is Hermes' default setup, and there is nothing to set up. The desktop app signs in by itself. Started with `npm run dev`, the server prints a sign-in link in the terminal: open that link.
- **Hermes behind a username and password** (`dashboard.basic_auth` in the Hermes configuration; see "Web Dashboard", section "Authentication", in the Hermes documentation). HermesBot shows a sign-in form.

> [!NOTE]
> Without a password, HermesBot must run on the same Mac and under the same macOS account as Hermes. It reads the session token Hermes keeps in its own home (`~/.hermes`, or the folder named by `HERMES_HOME`) and sends it to that gateway only. A Hermes reached through the SSH tunnel, or run by another account, needs the username and password sign-in.

Every Hermes profile shows as a bot, except `default` and a profile named `notify`. A profile can carry a card that sets its name, role and group, under `ui_meta["hermes-bots"]`: `title`, `description`, `sectionName` and `sectionId`. Profiles without a card go under "Unassigned".

> [!WARNING]
> Sending a message starts a turn with the model set in the bot's Hermes profile. Depending on your provider, a message can cost money.

### A gateway on another machine

If nothing answers on the gateway address, the desktop app can open an SSH tunnel to the machine that runs Hermes. Set `sshHost` (see Settings) to an SSH host alias that connects without a password prompt. The tunnel forwards port 9120 and closes with the app.

## Desktop app

```bash
npm run desktop    # build, then open the app with Electron
npm run pack       # build release/mac-arm64/HermesBot.app
```

`npm run pack` makes an unsigned app for Apple silicon. An app you build yourself opens normally; one copied from another Mac is quarantined by macOS until you allow it. There is no prebuilt download and no automatic update.

**Notifications need a signed build.** macOS drops the notifications of an app whose code signature does not carry its bundle identifier, and an unsigned package carries the runtime's. `HERMESBOT_MAC_SIGN=adhoc npm run pack` signs the app's executable ad hoc with its identifier ([scripts/mac-sign.cjs](scripts/mac-sign.cjs)); no certificate is needed. The first launch of a build signed this way asks once for the Keychain item that holds your session ("Always Allow"); later builds do not ask again while the Electron version stays the same. Settings > General has a "Test notification" button.

The desktop app keeps your session between launches, encrypted with the macOS Keychain. With "Stay signed in on this Mac" ticked, it also keeps your password the same way, to sign in again when the Hermes session expires. Neither is ever sent back to the window.

## Settings

All settings are optional. Each one is an environment variable, or a key of `config.json` in `~/Library/Application Support/HermesBot/`. [.env.example](.env.example) lists them all.

| Variable | Key in `config.json` | Default | Purpose |
|---|---|---|---|
| `HERMES_ORIGIN` | `gatewayOrigin` | `http://127.0.0.1:9120` | Address of the Hermes gateway |
| `HERMES_BROWSER_ORIGIN` | `browserOrigin` | same as the gateway | `Origin` header sent to the gateway, when it only trusts its public address behind a reverse proxy |
| `HERMES_SSH_HOST` | `sshHost` | none | SSH host alias for the tunnel to a remote gateway |
| `HERMES_HOME` | `hermesHome` | `~/.hermes` | Home of the Hermes on this Mac, for the sign-in without a password |
| `OLLAMA_ORIGIN` | `ollamaOrigin` | `http://127.0.0.1:11434` | Ollama, for the local chat |
| `HERMESBOT_ANIMATIONS` | `animationsDir` | `animations/` in the data folder | Folder of bot animations |
| `PORT` | | `4330` | Port of the local server |

Interface preferences (`ui.defaultBot`, `ui.sectionOrder`, `ui.userInitial`…) only exist in `config.json`.

## Optional extras

- **Local chat.** With [Ollama](https://ollama.com) running, a "Local" entry in the roster chats with a model installed on your machine. You pick the model in Settings > Chats. This chat never goes through Hermes and never gets tools.
- **Bot animations.** Put `<profile>-working.webp` and `<profile>-done.webp` in the animations folder. The bot then plays the first while it works and the second when it finishes. Without them, bots keep a still avatar.
- **Mail approval card.** With the skill in [skills/mail-approval/](skills/mail-approval/), a bot shows an email draft as a card you can edit before it goes out (the skill uses [himalaya](https://github.com/pimalaya/himalaya)). Only the fields you approved are sent; the skill's script refuses a mail that no longer matches them, or the same mail twice.
- **Vault for a shared Chrome.** For bots that drive a Chrome over CDP: a small service (`server/browser-vault/`) keeps site logins in the macOS login keychain and types them into the bot's tab itself, so the password never reaches the bot's context. It needs your own setup (a launchd agent for `server/browser-vault/standalone.mjs`, and the skill in [skills/browser-vault/](skills/browser-vault/)). Read "Security" below before using it.

## How it works

```
window (React)  ──HTTP + WebSocket──▶  local server (Node, 127.0.0.1:4330)  ──▶  Hermes gateway (127.0.0.1:9120)
```

- `src/`: the interface. React 19, TypeScript, Zustand stores in `src/store/`, texts in `src/i18n/locales/{en,fr}/`.
- `server/`: the local server. It signs in to Hermes, keeps Hermes cookies and WebSocket tickets on its side, and relays JSON-RPC (`hermes-gateway-v1`), media and documents. `server/config.cjs` reads the settings.
- `electron/`: the macOS shell. It runs the same server in its main process, keeps sessions in the Keychain and opens the SSH tunnel.
- `tests/e2e.mjs`: an end-to-end run against a fake gateway and a fake Chrome. No model is ever called.
- `skills/`: optional Hermes skills that go with the app.

## Security

- The local server listens on `127.0.0.1` only and rejects requests whose `Host` or `Origin` is not local.
- Hermes cookies and tickets stay in the server process. The window only gets an opaque session id.
- Bot output is treated as hostile. No remote image or resource ever loads. Bot files only pass through the local server, with a fixed content type and no SVG. HTML documents run in a sandboxed iframe with no network and no access to the app.
- HermesBot trusts whatever answers on the gateway address. A local process that took that port would receive your password, but it would already run with your rights.
- Without a password, the server reads Hermes' session token from the Hermes home at each use. It never stores it and never sends it to the window. For every request that carries the token, it opens the connection to `127.0.0.1` first, then checks that the process at the other end of that connection is the gateway of that home (the gateway names itself on its private control socket). A process of another account, an SSH tunnel, or whoever takes the port between two requests never gets the token.
- That sign-in opens for the desktop app's own window, or for whoever has the link the server printed, and for nobody else: any process on the Mac can reach the server's port.
- The shared-Chrome vault keeps asking for a username and password session before any change. A bot can read the Hermes token of its own account, so that token proves nothing there.
- HermesBot does not sandbox your bots. They run with the rights of the Hermes gateway's user; use Hermes' own approvals and terminal backends for that.
- The shared-Chrome vault protects against mistakes, not against a hostile bot. Its bots run under the same macOS account as the keychain, so a bot with a terminal could read a saved password or a filled page.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Tests

```bash
npm run check      # typecheck and unit tests
npm run test:e2e   # end-to-end run, needs macOS and Google Chrome
```

## Known limits

- The sign-in without a password only works for a Hermes on the same Mac and under the same account. It relies on the session token of Hermes' Webapp, which is not a documented interface for other apps: a Hermes update can break it.
- Other Hermes sign-ins, such as OAuth, are not supported.
- macOS only, and the packaged app is for Apple silicon. The server and the interface may run elsewhere with `npm run dev`, but this is not tested.
- Groups and routines cannot be created or edited from the app yet. A bot can be created, renamed, moved, hidden and deleted; its instructions, skills and tools are still edited in Hermes.
- Deleting a bot from the app takes it out of the roster and keeps its Hermes profile, files, history and scheduled jobs. `hermes profile delete <name>` erases it for good.
- Most features are verified against the simulated gateway of the test suite and on the author's own setup, not on a wide range of Hermes versions. The gateway contract can change between Hermes releases.
- The SSH tunnel is not restarted by itself when it drops. The reconnect button at the bottom of the roster tries to reopen it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## Credits and license

MIT License, see [LICENSE](LICENSE). Third-party work is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

HermesBot is an independent project: it is not affiliated with, endorsed by or connected to Nous Research or any provider named in the app. Some behaviors, such as `MEDIA:` lines and the note added for an `@mention`, follow Hermes Desktop.
