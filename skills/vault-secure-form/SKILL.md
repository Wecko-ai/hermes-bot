---
name: vault-secure-form
description: Ask the user for payment or shipping details through HermesBot’s secure vault form. Raw values never pass through chat or logs.
---

# Secure vault form (HermesBot)

When you need card or address data, emit a fenced block in your assistant message. HermesBot renders a secure card; the user fills it in. Values go to the macOS keychain on the bots machine. You only receive `hbvault:*` references in the user’s acknowledgement message.

## Block format

````markdown
```hermes-vault-form
id: unique-form-id
title: Short title shown on the card
- key: card kind: card label: Card number
- key: ship kind: address label: Shipping address
```
````

### Fields

- `id` — stable id for this request (letters, numbers, hyphens).
- `title` — shown on the card.
- Each field line:
  - `key` — identifier for your follow-up (alphanumeric).
  - `kind` — `text`, `card`, or `address`.
  - `label` — visible label.
  - `optional: true` — omit if required.

## After submit

The user message looks like:

`[HermesBot vault] Secure form "Billing" stored. Refs: hbvault:card:…, hbvault:address:…. Raw values never leave the vault.`

Use those references in tools or later steps. Never ask the user to paste card numbers or full addresses in chat.

## Rules

- Never echo card numbers, CVV, or full addresses in your replies.
- Do not call `/admin` APIs or read the vault token.
- If `features.vaultWallet` is off on the user’s install, the block stays inert; ask the user to enable **Vault wallet** in config and use password vault flows instead.