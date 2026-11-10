---
name: coffre-chrome
description: Use when a site in your team's bots Chrome (CDP address from `browser-turn cdp --owner <you>`) asks you to log in, or asks for a verification code. Never type or read a password yourself.
---

# Log in inside your team's Chrome with the HermesBot vault

The HermesBot vault keeps credentials in the macOS login keychain of the bots' machine. It types the password into YOUR tab itself: you never see the password, and it goes through neither the chat, nor your tools, nor the logs.

Command, from any folder:

```bash
node <path to HermesBot>/scripts/browser-vault.mjs <list|save|fill|code> --bot <your profile> [--target <targetId>]
```

`<path to HermesBot>` is the folder where the HermesBot repository is cloned on the bots' machine.

`targetId` is the id of YOUR tab: the one returned by `PUT /json/new?<url>` (or `cdp.mjs new`). Never a tab you did not open.

## Rules

- Each team of bots has its own Chrome. Take your turn first, as for any access to that Chrome (`browser-turn prendre --owner <your profile>`, which also gives its CDP address; `browser-turn cdp --owner <your profile>` gives it again), and give it back afterwards.
- Never type, read, copy or display a password: no `eval` on a `password` field, no `.value`, no screenshot of a filled-in form sent in a message.
- Never ask the user for a password in the chat: the vault opens a secure window for them in HermesBot.
- In your team's Chrome, use this vault, not Hermes's `browser_vault` tool: that one stores passwords elsewhere.
- Only the four commands above. Never call the vault's `/admin` API, read its token, or look for a password in the keychain (`security`): that is reserved for the user and the HermesBot app.
- In a scheduled task (cron): never `save` or `code`, nobody is there to answer. If `fill` is not enough, stop and report it.

## Steps

1. `list --bot <profile>`: the sites you are allowed to use (origin and username, never a password).
2. Open the login page in your tab and check `location.origin`.
3. If the origin is listed: `fill --bot <profile> --target <targetId>`. Response `{"status":"filled","fields":["identifier","password"]}`. Then click the login button yourself.
4. Otherwise: `save --bot <profile> --target <targetId>`. The user receives "<bot> needs your credentials" in HermesBot. The command waits up to 6 minutes.
   - `{"status":"saved"}`: run `fill` again.
   - `{"status":"cancelled"}`: the user answered "Later". Do not ask again during this turn; say so in your reply.
5. Verification code:
   - received by email: read it in your mailbox and type it yourself (a one-time code is not a password);
   - otherwise: `code --bot <profile> --target <targetId>`. The user types the code into HermesBot and the vault injects it into the page.

## Errors

- `origin_not_found`: no credentials for this site. Run `save`.
- `bot_not_allowed`: the credentials are reserved for other bots. Ask the user to authorize you (HermesBot, Settings, Vault). Do not work around it with `save`.
- `origin_mismatch`: the page changed site during the call. Check the URL, then start again.
- `login_fields_not_found` or `code_field_not_found`: no field recognized. Show the right form (the "Sign in" step, the password field), then start again.
- `target_required`: `--target` is missing.
- `vault_unavailable`, `vault_service_unavailable`, `request_timeout`, `cdp_unavailable`: stop and report it.
