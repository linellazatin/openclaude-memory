---
name: memory
description: "Read and write global persistent memory across opencode sessions"
version: 0.1.0
author: Lines
license: MIT
platforms: [linux, macos]
metadata:
  opencode:
    tags: [memory, persistence, context]
---

# Global Memory

Global memory persists across all opencode sessions. It lives at:

```
~/.config/opencode/memory/
├── MEMORY.md              # index — injected into every session automatically
└── <topic>.md             # detail files — read on-demand
```

## Available tools

The plugin registers three native tools. Use these instead of raw Write/Edit tools for all memory operations — they handle file format, frontmatter, and index maintenance automatically.

| Tool | Args | What it does |
|---|---|---|
| `write_memory` | `topic`, `content`, `summary`, `pin?` | Creates or appends to a topic file; upserts MEMORY.md index entry |
| `remove_memory` | `topic` | Removes the index entry (refuses if pinned); topic file preserved |
| `pin_memory` | `topic`, `pin` (bool) | Pins or unpins an index entry |

## Reading memory

`MEMORY.md` is already in your context (injected by the plugin). You do not need to re-read it unless you have just written to it and want to verify.

To read a topic file for detail:
```
Read ~/.config/opencode/memory/<topic>.md
```

To list all memory files:
```
Glob ~/.config/opencode/memory/*.md
```

## Writing memory

Use the `write_memory` tool. Do not use raw Write/Edit tools on memory files.

### Adding a new topic

Call `write_memory` with:
- `topic`: the topic name, e.g. `"PostgreSQL Setup"`
- `content`: the full detail content to write
- `summary`: a one-line summary for the index
- `pin`: `true` if the topic is permanent (hardware, user identity, core workflows)

The plugin will:
1. Derive a slug filename from the topic name (lowercase, hyphens)
2. Create the file with YAML frontmatter stamped automatically
3. Add a new index line to `MEMORY.md` with today's date

### Updating an existing topic

Call `write_memory` with the same `topic` name. The plugin appends the new content under a `## YYYY-MM-DD` heading. The index date is updated automatically.

### Index discipline

- `MEMORY.md` must stay under the configured `max_lines` limit (default 200; set in `## Config` section of `RULES.md`). One line per topic.
- Never expand an index entry beyond one line. Put detail in the topic file.
- After any write, verify `MEMORY.md` line count and trim if needed.
- Entries with `[pin]` are exempt from all cleanup and staleness logic — never suggest removing them.

### Pinning and unpinning

Use `pin_memory({ topic, pin: true })` to pin. Use `pin_memory({ topic, pin: false })` to unpin.

Use `[pin]` for topics that should never be cleaned up: hardware specs, user identity, core workflows, permanent reference material.

Never remove `[pin]` from an entry unless the user explicitly asks.

## Staleness flags

The plugin stamps `[stale?]` on index entries older than `stale_after_days` (default 180, configurable in `RULES.md`). The flag appears in the index line, after the date:

```
- [Topic Name](file.md) 2025-11-01 [stale?] -- summary
```

`[stale?]` means "this entry has not been updated in a while — worth reviewing". It is a candidate signal, not a deletion order.

**How `[stale?]` self-heals**: when you call `write_memory` on a stale topic, the plugin updates the date and removes `[stale?]` from that entry automatically during the next index maintenance pass.

**Pinned entries are never flagged** regardless of age.

**Entries with no date** are never flagged — they are treated as legacy entries.

When you see `[stale?]` entries in the index, you can:
- Ask the user if the topic is still relevant
- Call `write_memory` to refresh it (flag disappears automatically)
- Call `remove_memory` to delete the index entry if clearly obsolete

## When the cap is hit

If the injected `## Global Memory` block contains a truncation warning (`memory truncated`), the index has exceeded the configured line limit and must be trimmed. Steps:

1. Read `MEMORY.md` in full to assess all entries.
2. Identify entries that are candidates for removal. Check in this order:
   - **Skip immediately**: any entry with `[pin]` — never a removal candidate.
   - **Objective (remove without judgment)**: entry points to a topic file that no longer exists on disk; or two entries point to the same filename (keep the one with the more recent date, remove the other). Use `remove_memory` for these.
   - **Conservative judgment (remove only if clearly obsolete)**: topic was session-specific and no longer applies; topic is fully superseded by a newer broader entry. When in doubt, keep the entry. Use `remove_memory` for these.
   - **`[stale?]` entries**: these are prioritised candidates — review them first.
3. If all entries are still valid but the count is high, consolidate: merge two closely related topic files into one using `write_memory`, then `remove_memory` on the now-redundant entry.
4. Topic file content is never deleted — only index lines are removed.
5. Re-read `MEMORY.md` after trimming to confirm it is under the configured limit.

## Persist rules

Your persist rules are in `~/.config/opencode/memory/RULES.md` and are injected into your context under `## Memory Rules` each session. Follow them.

If no `## Memory Rules` block is in your context, read `~/.config/opencode/memory/RULES.md` directly.
