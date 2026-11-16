---
name: coffre-chrome
description: Use when a site in your team's bots Chrome (CDP address from `browser-turn cdp --owner <you>`) asks you to log in, to create an account, or for a verification code. Never type or read a password yourself.
---

# Log in inside your team's Chrome with the HermesBot vault

The HermesBot vault keeps credentials in the macOS login keychain of the bots' machine. It types the password into YOUR tab itself: you never see the password, and it goes through neither the chat, nor your tools, nor the logs.

Command, from any folder:

```bash
node <path to HermesBot>/scripts/browser-vault.mjs <list|save|fill|code|signup> --bot <your profile> [--target <targetId>] [--identifier <login> (signup)]
```

`<path to HermesBot>` is the folder where the HermesBot repository is cloned on the bots' machine.

`targetId` is the id of YOUR tab: the one returned by `PUT /json/new?<url>` (or `cdp.mjs new`). Never a tab you did not open.

## Rules

- Any password, login or verification code a site asks for goes through this vault, automatically: do not wait for the user to tell you to use it.
- Each team of bots has its own Chrome. Take your turn first, as for any access to that Chrome (`browser-turn prendre --owner <your profile>`, which also gives its CDP address; `browser-turn cdp --owner <your profile>` gives it again), and give it back afterwards.
- Never type, read, copy or display a password: no `eval` on a `password` field, no `.value`, no screenshot of a filled-in form sent in a message.
- Never ask the user for a password in the chat: the vault opens a secure window for them in HermesBot.
- Before `save`: if the page offers "Continue with Google" (or Apple, Microsoft) and the account could be one the user opens that way, try that button first and pick the account already signed in in this Chrome. Run `save` only if that does not work. If `save` answers `use_sso`, follow its `next`.
- Never use Hermes's own `browser_vault` tool in your team's Chrome: that one stores passwords elsewhere. Only this vault.
- Only the five commands above. Never call the vault's `/admin` API, read its token, or look for a password in the keychain (`security`): that is reserved for the user and the HermesBot app.
- In a scheduled task (cron): never `save`, `code` or `signup`, nobody is there to answer. If `fill` is not enough, stop and report it.
- When a site shows a QR code to scan (phone verification, sign-in from an app): take a screenshot of the QR element only, with CDP `Page.captureScreenshot` and a `clip` on its bounding box (`getBoundingClientRect()` plus the page scroll, `scale: 1`). Save it as a PNG file, put its absolute path in your reply as `MEDIA:<absolute path>` so the user can scan it from their phone, then wait. Never capture the rest of the page.

## Steps

1. `list --bot <profile>`: the sites you are allowed to use (origin and username, never a password).
2. Open the login page in your tab and check `location.origin`.
3. If the origin is listed: `fill --bot <profile> --target <targetId>`. Response `{"status":"filled","fields":["identifier","password"]}`. Then click the login button yourself.
4. Otherwise: `save --bot <profile> --target <targetId>`. The user receives "<bot> needs your credentials" in HermesBot. The command waits up to 6 minutes.
   - `{"status":"saved"}`: run `fill` again.
   - `{"status":"use_sso","provider":"google","next":"…"}`: the user signs in to this site with that provider (`google`, `apple` or `microsoft`), not with a password. Do what `next` says: click the site's "Continue with <Provider>" button and pick the account already signed in in this Chrome. Nothing was stored; do not run `save` again for this site.
   - `{"status":"cancelled"}`: the user answered "Later". Do not ask again during this turn; say so in your reply.
   - On the provider's own sign-in page (`accounts.google.com`, `appleid.apple.com`, `login.live.com`, `login.microsoftonline.com`), the user is asked for that provider account's own credentials: `use_sso` is not offered there.
5. Verification code:
   - received by email: read it in your mailbox and type it yourself (a one-time code is not a password);
   - otherwise: `code --bot <profile> --target <targetId>`. The user types the code into HermesBot and the vault injects it into the page.

## Create an account

When a site asks you to create an account, use `signup`. Never invent, type or read a password, and never chain `save` and two `fill` for a new account.

1. Fill in everything else yourself (name, birth date, the e-mail or username you register) and go to the step that shows the password field (and its confirmation).
2. `signup --bot <profile> --target <targetId> --identifier <login>`. `<login>` is the e-mail or username you register: not a secret. The user receives "<bot> wants to create an account on <site> with <login>" in HermesBot. The command waits up to 6 minutes.
   - `{"status":"filled","saved":true,"fields":[…]}`: the vault generated a strong password, stored it for this site (reserved for you) and typed it into every visible password field, plus the login field if one was visible. Submit the form yourself.
   - `{"status":"saved","saved":true,"filled":false,"error":"…"}`: stored but not typed. Show the password step again, then run `fill`.
   - `{"status":"cancelled"}`: the user declined. Do not ask again during this turn; say so in your reply.
3. Next logins on that site: `fill`, as above.

## Errors

- `origin_not_found`: no credentials for this site. Run `save`.
- `bot_not_allowed`: the credentials are reserved for other bots. Ask the user to authorize you (HermesBot, Settings, Vault). Do not work around it with `save`.
- `origin_mismatch`: the page changed site during the call. Check the URL, then start again.
- `login_fields_not_found` or `code_field_not_found`: no field recognized. Show the right form (the "Sign in" step, the password field), then start again. After `signup`, nothing was stored.
- `entry_exists`: credentials are already stored for this site (one per site). Use `fill`; for another account on that site, ask the user to remove the old one first (HermesBot, Settings, Vault).
- `invalid_credentials` after `signup`: `--identifier` is missing or invalid.
- `target_required`: `--target` is missing.
- `vault_unavailable`, `vault_service_unavailable`, `request_timeout`, `cdp_unavailable`: stop and report it.
