---
description: "Usage: /memory → show | /memory <text> → store | /memory pin <topic> → pin | /memory remove <topic> → remove entry"
---

Memory dir: ~/.config/opencode/memory/
Memory index: ~/.config/opencode/memory/MEMORY.md

Arguments: $ARGUMENTS

## No arguments: show index

Read and display ~/.config/opencode/memory/MEMORY.md. For each entry, show whether it is pinned ([pin]) or not. List all .md files in the directory. Do not write anything.

After listing, append this legend:
```
Tip: /memory <text> to store  |  /memory pin <topic> to pin  |  /memory remove <topic> to remove
```

## Arguments start with "remove ": remove an index entry

The text after "remove " is the topic to find. Steps:
1. Read ~/.config/opencode/memory/MEMORY.md.
2. Find the index line whose topic name or filename contains the search text (case-insensitive).
3. If no match found: report "no matching entry found" and stop.
4. If the entry has [pin]: refuse removal and report "entry is pinned; unpin it first by editing MEMORY.md directly". Stop.
5. Remove that line from MEMORY.md. Do not delete the topic file.
6. Check if a topic file for this entry exists in ~/.config/opencode/memory/. If it does, note it in the confirmation: "Index entry removed. Topic file <filename> still exists on disk."
7. Confirm: which entry was removed.

## Arguments start with "pin ": pin an entry

The text after "pin " is the topic to find. Steps:
1. Read ~/.config/opencode/memory/MEMORY.md.
2. Find the index line whose topic name or filename contains the search text (case-insensitive).
3. If no match found: report "no matching entry found" and stop.
4. If already pinned: report "already pinned" and stop.
5. Insert [pin] immediately after the closing ] of the filename link, before any date or --. Do not change any other part of the line.
   Examples:
   Before: - [Homelab Server](homelab-server.md) 2026-07-20 -- Intel i5...
   After:  - [Homelab Server](homelab-server.md) [pin] 2026-07-20 -- Intel i5...

   Before: - [Some Topic](some-topic.md) -- summary text
   After:  - [Some Topic](some-topic.md) [pin] 2026-07-21 -- summary text
6. Write the updated line back to MEMORY.md.
7. Confirm: which entry was pinned.

## Arguments provided (not starting with "pin " or "remove "): store a memory

Treat arguments as a fact or note to persist. Steps:
1. Decide whether it belongs in an existing topic file or warrants a new one.
2. Write to the appropriate topic file.
3. Update the index entry in MEMORY.md. Set last_updated to today's date (YYYY-MM-DD). Preserve [pin] if present. Preserve the -- summary. Do not change any other part of the line.
   Examples of the index entry update:
   Before: - [Topic](file.md) -- summary
   After:  - [Topic](file.md) 2026-07-21 -- summary

   Before: - [Topic](file.md) [pin] 2026-06-01 -- summary
   After:  - [Topic](file.md) [pin] 2026-07-21 -- summary

   Full format for a new entry: - [Name](file.md) [pin] YYYY-MM-DD -- summary  (omit [pin] if not permanent)
4. If a new topic file was created, add a new index line with today's date. Add [pin] if the topic is clearly permanent (hardware, user identity, core workflows).
5. Confirm: what was stored, which file, whether MEMORY.md was updated.

Any text including single words is treated literally as content to store. Do not interpret "show", "list", or similar as subcommands unless the full argument starts with "pin " or "remove ".
