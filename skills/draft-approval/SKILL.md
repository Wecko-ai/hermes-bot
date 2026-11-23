---
name: draft-approval
description: "Live conversation with the user only. Use when a message to X, Slack or Telegram must be approved in HermesBot before it is sent."
version: 1.0.0
metadata:
  hermes:
    tags: [Approval, HermesBot, Social]
---

# Outbound message drafts

HermesBot shows a **draft card** from a fenced `hermes-draft` block. Only fields shown on the card are sent after approval (`Approved-Digest`).

## Propose a draft

In your reply, add exactly:

`````text
````hermes-draft
Id: <short unique id>
Channel: x|slack|telegram
Recipient: <handle, channel, or chat id>
Thread: <thread or reply id, or empty>
Attachments: <paths or ids listed on the card, or empty>

<message body in plain text>
````
`````

Do not send the message yourself. Wait for a `hermes-draft-approved` block from the user.

## When you receive `hermes-draft-approved`

The block is the user's approval for this draft only. Send once through the channel's normal outbound path (API or integration the profile already has). Nothing outside the card may be sent.