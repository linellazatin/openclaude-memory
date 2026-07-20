---
name: memory
description: "Read and write global persistent memory across opencode sessions"
version: 1.0.0
author: openclaude-memory
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
4. Add one line to `MEMORY.md` index:
   ```
   - [Topic Name](<slug>.md) -- <same one-line summary>
   ```

### Updating an existing topic

1. Read the existing topic file.
2. Edit it with new information — append under a `## <date>` heading or update the relevant section.
3. If the one-line summary in `MEMORY.md` is stale, update it.

### Index discipline

- `MEMORY.md` must stay under 200 lines. One line per topic.
- Never expand an index entry beyond one line. Put detail in the topic file.
- Topic file names: lowercase, hyphens, no spaces (e.g. `local-llm-models.md`).
- After any write, verify `MEMORY.md` line count with Read and trim if needed.

### When the cap is hit

If the injected `## Global Memory` block contains a truncation warning (`memory truncated`), the index has exceeded the 200-line / 25KB limit and must be trimmed before the next write. Steps:

1. Read `~/.config/opencode/memory/MEMORY.md` in full.
2. Identify entries that are stale (topic no longer relevant), superseded (merged into another topic), or duplicated.
3. Remove those index lines from `MEMORY.md`. Do not delete the topic files themselves — only remove the index entry.
4. If all entries are still valid but the count is high, consolidate: merge two closely related topic files into one, update the single index entry to reflect the combined scope, leave the old file in place or remove it only if all content was moved.
5. Re-read `MEMORY.md` after trimming to confirm it is under 200 lines.

## What to persist

Persist without asking:
- Solved bugs and their root causes
- Server, infra, or environment configuration discovered or changed
- Reusable commands, flags, or workflows
- Hardware specs, model configs, tool versions

Ask before persisting:
- Credentials, tokens, API keys
- Personal data
- Anything the user marks as private or ephemeral

## What NOT to persist

- Session-specific context that won't apply to future sessions
- Opinions or preferences not confirmed by the user
- Large blocks of code — summarize instead, or link to the file path
