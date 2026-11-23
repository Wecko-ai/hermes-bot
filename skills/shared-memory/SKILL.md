---
name: shared-memory
description: Read the user's shared HermesBot memory files (profile, rules, people, workstreams).
---

# Shared memory (HermesBot)

HermesBot can keep a **shared memory** on the Mac where the desktop app runs: four Markdown files (`profile.md`, `rules.md`, `people.md`, `workstreams.md`) under the app data directory (config key `sharedMemory.dir`).

## When to use

- Before asking the user something that may already be in shared memory.
- When you need durable facts that apply to **all** bots (not only your profile `MEMORY.md`).

## How to read (opt-in)

The desktop app does **not** mount these files into your profile automatically. Options:

1. **Per-turn injection** (installation): if `sharedMemory.injectContext` is enabled in the app's config, the user messages already carry a short English summary in `api_text` for that turn only.
2. **Manual read**: if your environment exposes the directory, read the files with your file tools. Never copy secrets from them into chat logs.

## Entry format

Each entry is a level-2 heading with metadata:

```markdown
## Title
<!-- memory: 2026-11-22T12:00:00Z | source: user -->
Body text.
```

Respect `source` and `date` when citing memory back to the user.