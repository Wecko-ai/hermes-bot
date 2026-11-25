# email-drafts (agent plugin)

From [Hermes Bot Kit](https://github.com/thomasbek3/hermes-bot-kit) (MIT, see [NOTICE.md](NOTICE.md)),
adapted for HermesBot.

Bots never send email on their own. A bot writes a **draft**; HermesBot shows it as a card in the bot's chat:
From, "En réponse à", editable To and Cc, subject and body, the signature under it, the attachments, and
**Ignorer** / **Envoyer**. Only your click on **Envoyer** sends it, through **himalaya** (the mail CLI
HermesBot already uses for `hermes-mail` cards), or optionally Gmail with your own OAuth client, or SMTP.
The card then says "Envoyé · 15:42" and is read-only; a failure shows the error with **Réessayer**.

The card's footer has the bot's rules menu:

| Menu item | What it does |
|---|---|
| **Autoriser le destinataire** | Adds this draft's To addresses to the bot's allowed list and turns the allow rule on. Later drafts whose recipients (To, Cc and Bcc) are **all** on the list send by themselves ("Envoyé automatiquement"). The current draft still waits for **Envoyer**. |
| **Approbation requise** | The default. Every draft waits for **Envoyer** (the allowed list is kept, unused). |
| **Désactiver les brouillons** | The bot's draft tool refuses with a message the bot relays. Nothing is drafted. |
| **Gérer les règles** | The allowed list with **Retirer** buttons, and the mode. |

Rules are per bot (per Hermes profile), stored in `<HERMES_HOME>/plugin-data/email-drafts/rules.json`.
Until you change them, **everything needs approval**.

## What the bot gets

Three tools in the `email_drafts` toolset. There is **no send tool**.

- `email_draft_create(to, cc?, bcc?, subject, body, attachments?, in_reply_to?)` → the draft id and status
  (`pending`, `sent` when the allow rule covered it, or `disabled` with a message to relay).
- `email_draft_update(id, …)` → change a pending draft (the card refreshes).
- `email_draft_status(id)` → `pending`, `sending`, `sent` (when, and by whom), `discarded` or `failed`.

The plugin registers the skill `email-drafts:email-drafts` ([skills/email-drafts/SKILL.md](skills/email-drafts/SKILL.md)).
On a profile that has it, it replaces the `hermes-mail` fence + `mail-approval` flow. Suggested `SOUL.md` line:

```text
E-mail : n'envoie jamais toi-même (ni himalaya, ni script, ni SMTP). Écris un brouillon avec
email_draft_create ; l'envoi se fait depuis la carte, uniquement après un clic. Réponds ensuite en une ligne, sans recopier le mail.
Pour une correction, email_draft_update sur le même brouillon.
```

**Attachments** must be files inside the bot's working directory for the chat, or inside a folder listed in
**Extra attachment folders**. Paths are resolved with symlinks followed, so a link that points outside is
refused; hidden files and folders (`.ssh`, `.env`, `.hermes` …) are refused everywhere; the check runs again
just before sending. The home folder and `/` never count as a workspace on their own: a bot whose working
directory is your home folder can attach files only from the folders you list.

**Replies** thread: `in_reply_to.message_id` becomes `In-Reply-To` and `References` (all senders), and
with the Gmail sender `in_reply_to.thread_id` is sent as Gmail's `threadId`.

**Scheduled runs** (cron, a gateway with no one watching) only create drafts and return at once; nothing ever
waits for a person. A draft whose recipients are all allowed still sends under the allow rule. Type
`/email-drafts` in a chat to list a bot's drafts.

## Never twice

A draft goes `pending → sending → sent | failed`. The step to `sending` is taken under a file lock, so a double
click, a second window or a repeated request finds the draft already `sending` or `sent` and sends nothing.
**Send** carries the card's revision: if the bot changed the draft after the card showed it, nothing is sent
and the card asks you to look again. An error the plugin cannot classify (the connection dropped after the
message was handed over, or himalaya timed out or was killed mid-send) marks the draft
"Delivery unknown: check your Sent folder" and offers no Retry. The
card itself keeps one action in flight and never repeats a send whose answer was lost.

## Approval and the audit log

Your click on **Send** is the approval; the allow rule, which only you can set from the card, is the only other
way a draft leaves. Hermes's approval system has no public way for a plugin to record "a person approved this
outbound action", so the plugin does not touch it (it never answers or bypasses Hermes approval prompts). It
writes its own audit log instead: `<HERMES_HOME>/plugin-data/email-drafts/audit.jsonl`, one line per draft
created, send, failure, discard and rule change, with `actor` (`human` click or `allow-rule`), the surface
(`rpc`, `slash:<platform>` or `tool`) and the time. Message bodies are never logged.

Send, discard and rule changes are refused from the plain CLI's `/email-drafts api …` (a bot's terminal could
start a Hermes child there). This plugin is not a sandbox: like any plugin it runs as your user, and a bot
with an unrestricted terminal can read or write files your user can.

## Install (named profiles only, nothing live without a go)

Requires Hermes **0.23.0** or newer.

```bash
bash hermes-plugins/email-drafts/install.sh --profiles alice \
     --from contact@example.com --account contact                  # dry run: prints every step
bash hermes-plugins/email-drafts/install.sh --profiles alice \
     --from contact@example.com --account contact --apply          # copy + enable + settings
bash hermes-plugins/email-drafts/install.sh --profiles alice --uninstall --apply
```

The script backs up `config.yaml`, copies the plugin to `<profile-home>/plugins/email-drafts`, runs
`hermes --profile <name> plugins enable email-drafts` and writes the settings under
`plugins.entries.email-drafts.settings`. The gateway loads it on its next restart.

### himalaya (default)

| Setting | Meaning |
|---|---|
| `from_address` | Required. The From of every draft; must be an address of the himalaya account. |
| `himalaya_account` | The himalaya account name (`himalaya account list`); empty = its default account. |
| `himalaya_sent_folder` | Folder to save a copy in after sending; empty = `--no-save` (an SMTP-only account has no folder). |
| `himalaya_cli` | Absolute path, only when himalaya is not on the gateway's PATH or in `/opt/homebrew/bin`. |
| `from_name`, `signature`, `attachment_dirs` | Optional. |

The plugin runs `himalaya [--account A] message send (--save F | --no-save)` with the full RFC 5322 message
on stdin: no shell, a minimal environment (PATH, HOME, USER, LANG), a 60 s timeout. A timeout or a kill
marks the draft "Delivery unknown" (no Retry); a non-zero exit marks it failed with himalaya's last error
line. himalaya keeps its own credentials; the plugin never reads them.

### Gmail (optional)

Set **Send with** to `gmail`, then:

1. In your own Google Cloud project, enable the Gmail API and create an OAuth client of type **Desktop app**.
2. Put its id and secret in that profile's `.env` as `EMAIL_DRAFTS_GOOGLE_CLIENT_ID` and
   `EMAIL_DRAFTS_GOOGLE_CLIENT_SECRET` (`hermes --profile <name> config env-path` shows the file).
3. Sign in once, in a terminal on the machine that runs the bot:

   ```bash
   hermes --profile <name> auth add email-drafts:google
   ```

The only scope is `https://www.googleapis.com/auth/gmail.send`: the plugin can send as that account and cannot
read the mailbox. Hermes stores and refreshes the token and attaches it to requests to
`gmail.googleapis.com`; the plugin never sees it. `hermes auth status|logout email-drafts:google` shows or
removes it.

### SMTP (optional)

Set **Send with** to `smtp`, then **SMTP host**, **port**, **security** (`starttls` on 587 or `ssl` on 465;
plain-text SMTP is not offered) and **username**, and the **SMTP password** field (stored by Hermes like a
provider key as `EMAIL_DRAFTS_SMTP_PASSWORD`, read with the profile's secret scope).

## What it touches (disclosure)

- **Network:** only when a draft is sent: himalaya to your SMTP server, or `https://gmail.googleapis.com`
  (Gmail sender), or your SMTP server (SMTP sender).
- **Programs it runs:** `himalaya` once per send (himalaya sender only).
- **Files it reads:** the attachments named on the draft, inside the allowed folders.
- **Files it writes:** `<HERMES_HOME>/plugin-data/email-drafts/` (drafts, rules, audit log).
- **Credentials:** none of its own. himalaya keeps its own; the Gmail grant lives in Hermes; the SMTP password
  is read through `agent.secret_scope.get_secret`.
- No background processes, no telemetry.

## The card's way in

HermesBot calls `plugin.email-drafts.api` (plugin RPC) on the gateway with `{op, profile, session_id, …}`.
`list` with the open chat's `session_id` returns that chat's drafts in the card view. Operations: `get`,
`list`, `rules` (read), `edit`, `send`, `discard`, `set_mode`, `allow`, `unallow`. Session events are not
needed: HermesBot re-reads the list when a turn ends and after each card action.

## Tests

```bash
cd hermes-plugins
python3 -m unittest discover -s email-drafts/tests -p 'test_*.py'   # fake himalaya, Gmail and SMTP; no email is sent
hermes plugins validate email-drafts
```
