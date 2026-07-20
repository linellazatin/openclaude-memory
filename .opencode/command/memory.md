---
description: "Usage: /memory → show index | /memory <text> → store a memory"
---

Global memory dir: ~/.config/opencode/memory/

## When called with no arguments (`/memory`)

- Read and display ~/.config/opencode/memory/MEMORY.md
- List all .md files in ~/.config/opencode/memory/ with their one-line summaries
- Do not write anything

## When called with text (`/memory <text>`)

`$ARGUMENTS` contains the fact or note to persist. Steps:
1. Decide whether `$ARGUMENTS` belongs in an existing topic file or warrants a new one
2. Write to the appropriate topic file at ~/.config/opencode/memory/<topic>.md
3. Update ~/.config/opencode/memory/MEMORY.md index if a new topic file was created or an existing summary changed
4. Confirm to the user: what was stored, which file it went into, whether MEMORY.md was updated

No other argument forms are valid. If `$ARGUMENTS` is ambiguous (e.g. a single word like "show" or "list"), treat it as text to store.
