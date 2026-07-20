---
description: "Usage: /memory → show index | /memory <text> → store a memory"
---

Memory dir: ~/.config/opencode/memory/

Arguments: $ARGUMENTS

If arguments are empty: read and display ~/.config/opencode/memory/MEMORY.md and list all .md files in the directory with their one-line summaries. Do not write anything.

If arguments are provided: treat them as a fact to persist — write to the appropriate topic file in ~/.config/opencode/memory/, update MEMORY.md if needed, confirm what was stored and where. Any text including single words is treated literally as content to store.
