---
description: /memory → show index | /memory <text> → store | /memory pin <topic> → pin | /memory unpin <topic> → unpin | /memory remove <topic> → remove entry | /memory consolidate → consolidate session
---

Memory dir: ~/.config/opencode/memory/
Memory index: ~/.config/opencode/memory/MEMORY.md

Arguments: $ARGUMENTS

## No arguments: show index

Read ~/.config/opencode/memory/MEMORY.md. Display each entry as a table with columns: Topic (name only — no markdown links, no filenames), Date, Pinned (yes/no), Stale (yes/no). List all .md files in ~/.config/opencode/memory/. Do not write anything.

After listing, append this legend:
Tip: /memory <text> to store  |  /memory pin <topic> to pin  |  /memory unpin <topic> to unpin  |  /memory remove <topic> to remove  |  /memory consolidate to consolidate this session

## Arguments start with "remove ": remove an index entry

The text after "remove " is the topic to find. Call the remove_memory tool:
  remove_memory({ topic: "<the text after 'remove '>" })

The tool will refuse if the entry is pinned and report the reason.

## Arguments start with "pin ": pin an entry

The text after "pin " is the topic to find. Call the pin_memory tool:
  pin_memory({ topic: "<the text after 'pin '>", pin: true })

## Arguments start with "unpin ": unpin an entry

The text after "unpin " is the topic to find. Call the pin_memory tool:
  pin_memory({ topic: "<the text after 'unpin '>", pin: false })

## Arguments are exactly "consolidate": consolidate memory from this session

Review the current conversation for facts, decisions, or discoveries that match the "always_persist" rules in ~/.config/opencode/memory.jsonc but have not yet been written to memory. For each one found, call write_memory with an appropriate topic, content, summary, and pin value.

Then write or update a topic named "Last Session Recap" (filename last-session-recap.md) summarizing what was accomplished this session, using mode: "replace" so it always reflects only the most recent session. Do not pin this entry — it is meant to be overwritten every session.

If nothing new was found to persist, say so plainly and do not call any tools.

## Arguments provided (not starting with "pin ", "unpin ", or "remove ", and not exactly "consolidate"): store a memory

Treat the arguments as a fact or note to persist. Decide the topic, a slug filename, a one-line summary, and whether the topic is permanent (hardware, user identity, core workflows = pin it). Then call the write_memory tool:
  write_memory({ topic: "<topic name>", content: "<the full fact or note>", summary: "<one-line summary>", pin: <true|false> })

The tool creates a new topic file or appends to an existing one, and updates the MEMORY.md index automatically.

Any text including single words is treated literally as content to store. Do not interpret "show", "list", or similar words as subcommands unless the full argument starts with "pin ", "unpin ", or "remove ", or is exactly "consolidate".
