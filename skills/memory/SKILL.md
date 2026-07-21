---
name: memory
description: "Read and write global persistent memory across opencode sessions"
version: 0.0.2
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

## Reading memory

`MEMORY.md` is already in your context (injected by the plugin). You do not need to re-read it unless you've just written to it and want to verify.

To read a topic file for detail:
```
Read ~/.config/opencode/memory/<topic>.md
```

To list all memory files:
```
Glob ~/.config/opencode/memory/*.md
```

## Writing memory

Use the standard Write and Edit tools.

### Adding a new topic

1. Create the topic file: `~/.config/opencode/memory/<slug>.md`
2. Add a YAML frontmatter block at the top:
   ```yaml
   ---
   name: <Topic Name>
   description: <one-line summary>
   metadata:
     node_type: memory
   ---
   ```
3. Write the detail content in markdown below the frontmatter.
4. Add one line to `MEMORY.md` index with today's date in ISO format. Add `[pin]` if the topic is permanent (hardware, user identity, core workflows):
   ```
   - [Topic Name](<slug>.md) [pin] YYYY-MM-DD -- <same one-line summary>   ← pinned
   - [Topic Name](<slug>.md) YYYY-MM-DD -- <same one-line summary>          ← normal
   ```

### Updating an existing topic

1. Read the existing topic file.
2. Edit it with new information — append under a `## <date>` heading or update the relevant section.
3. Update the index entry: set `last_updated` to today's ISO date (`YYYY-MM-DD`). Preserve `[pin]` if present. Preserve the `--` summary. If the summary is stale, update it.

### Index discipline

- `MEMORY.md` must stay under the configured `max_lines` limit (default 200; set in `## Config` section of `RULES.md`). One line per topic.
- Never expand an index entry beyond one line. Put detail in the topic file.
- Topic file names: lowercase, hyphens, no spaces (e.g. `local-llm-models.md`).
- After any write, verify `MEMORY.md` line count with Read and trim if needed.
- Entries with `[pin]` are exempt from all cleanup and staleness logic — never suggest removing them.

### Pinning entries

Use `[pin]` for topics that should never be cleaned up: hardware specs, user identity, core workflows, permanent reference material.

To pin an existing entry: use `/memory pin <topic name>`.

To add a pin when creating a new topic: include `[pin]` in the index line at creation time.

Never remove `[pin]` from an entry unless the user explicitly asks.

### When the cap is hit

If the injected `## Global Memory` block contains a truncation warning (`memory truncated`), the index has exceeded the configured line limit and must be trimmed before the next write. Steps:

1. Read `~/.config/opencode/memory/MEMORY.md` in full.
2. Identify entries that are candidates for removal. Check in this order:
   - **Skip immediately**: any entry with `[pin]` — never a removal candidate.
   - **Objective (remove without judgment)**: entry points to a topic file that no longer exists on disk; or two entries point to the same filename (keep the one with the more recent date, remove the other).
   - **Conservative judgment (remove only if clearly obsolete)**: topic was session-specific and no longer applies; topic is fully superseded by a newer broader entry. When in doubt, keep the entry.
3. Remove those index lines from `MEMORY.md`. Do not delete the topic files themselves — only remove the index entry.
4. If all entries are still valid but the count is high, consolidate: merge two closely related topic files into one, update the single index entry to reflect the combined scope, leave the old file in place or remove it only if all content was moved.
5. Re-read `MEMORY.md` after trimming to confirm it is under the configured limit.

## Persist rules

Your persist rules are in `~/.config/opencode/memory/RULES.md` and are injected into your context under `## Memory Rules` each session. Follow them.

If no `## Memory Rules` block is in your context, read `~/.config/opencode/memory/RULES.md` directly.
