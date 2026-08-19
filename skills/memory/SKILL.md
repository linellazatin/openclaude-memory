---
name: memory
description: "Read and write global persistent memory across opencode sessions"
version: 0.6.1
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
~/.config/opencode/
├── memory.jsonc            # persist rules and config — always local, never shared
└── memory/                 # or ~/.agents/memory/ if "shared_dir": true in memory.jsonc
    ├── MEMORY.md            # index — injected into every session automatically
    └── <topic>.md           # detail files — read on-demand
```

## Available tools

The plugin registers three native tools. Use these instead of raw Write/Edit tools for all memory operations — they handle file format, frontmatter, and index maintenance automatically.

| Tool | Args | What it does |
|---|---|---|
| `write_memory` | `topic`, `content`, `summary`, `pin?`, `mode?` | Creates or appends to a topic file; upserts MEMORY.md index entry |
| `remove_memory` | `topic` | Removes the index entry (refuses if pinned); topic file preserved |
| `pin_memory` | `topic`, `pin` (bool) | Pins or unpins an index entry |

## Memory Types

When calling `write_memory`, assign the topic to one of four categories. Types are an organizing convention for deciding *when* and *how* to write — the plugin does not enforce them and does not write a `type:` frontmatter field automatically.

| Type | What it stores | When to save | Body structure |
|---|---|---|---|
| `user` | Who the user is: role, expertise, preferences, tools, goals | When you learn something about the user that should change how you work with them in future sessions | Plain prose |
| `feedback` | How to approach work — corrections AND validated approaches | When corrected ("don't do X") OR when something non-obvious works well ("yes, keep doing that") | Rule → **Why:** → **How to apply:** |
| `project` | Ongoing work, decisions, constraints, deadlines | When you learn a non-obvious constraint, decision, or stakeholder requirement | Fact → **Why:** → **How to apply:** |
| `reference` | Pointers to external systems | When you learn where information lives (repos, boards, dashboards, channels, issue trackers) | Plain prose |

For `feedback` and `project` types, structure the body like this:

```
Rule or fact statement.

**Why:** The incident or preference that prompted this.
**How to apply:** When it kicks in and edge-case guidance.
```

Example:

```markdown
Don't mock the database in integration tests.

**Why:** Prior incident where mock/prod divergence masked a broken migration — mocked tests passed, prod deploy failed.
**How to apply:** Any time tests touch data persistence — always use the real DB, even in CI.
```

## When to save

Save **proactively** — without being asked — when you learn any of the following mid-session:

- Something about the user that should change how you work with them in future sessions (`user` type)
- An approach was corrected or a non-obvious approach was confirmed (`feedback` type)
- A non-obvious project constraint, decision, or deadline emerged (`project` type)
- You learned where something lives in an external system (`reference` type)

**What to always persist, never persist, and always ask before persisting** is user-configurable via `~/.config/opencode/memory.jsonc`. The plugin injects these rules into your context under `## Memory Rules` at the start of each session. Follow what is there — not a hardcoded list.

If `## Memory Rules` is not in your current context, read `~/.config/opencode/memory.jsonc` directly before deciding whether to save.

## Reading memory

`MEMORY.md` is injected into your context by the plugin on the first turn of each session, every `inject_every_n_turns` turns (default: 5), and immediately after any memory tool call. If it is not in your current context, read it directly:

```
Read ~/.config/opencode/memory/MEMORY.md
```

You do not need to re-read it unless you have just written to it and want to verify.

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
- `mode`: `"append"` (default) or `"replace"` — see "Updating an existing topic" below

The `summary` argument is written as `description:` in the file's YAML frontmatter by the plugin. Write it as a **relevance trigger** — the sentence that would cause you to load this file in a future conversation. Not a summary of what the file says; a trigger for *when* to read it.

```
Bad:  "Notes about the user's PostgreSQL setup"
Good: "Read when the user asks about database config, connection issues, or migration errors"
```

Do not embed a `description:` key in the `content` argument — content is written to the file body, not frontmatter.

The plugin will:
1. Derive a slug filename from the topic name (lowercase, hyphens)
2. Create the file with YAML frontmatter stamped automatically
3. Add a new index line to `MEMORY.md` with today's date

### Updating an existing topic

Call `write_memory` with the same `topic` name and one of two modes:

- `mode: "append"` (default) — adds the new content under a `## YYYY-MM-DDTHH:MM:SS±HH:MM` heading. Use for new information that extends an existing topic. The full history is preserved.
- `mode: "replace"` — overwrites the body, preserving frontmatter and advancing `last_updated`. Use when existing content is stale and the new content fully supersedes it. No dated heading is added.

**Pin-preservation**: passing `pin: false` to `write_memory` on an already-pinned entry does NOT unpin it — the existing `[pin]` is preserved. Use `pin_memory({ topic, pin: false })` to explicitly unpin.

### Index discipline

- `MEMORY.md` must stay under the configured `max_lines` limit (default 300; set via `"max_lines"` in `memory.jsonc`). One line per topic.
- Never expand an index entry beyond one line. Put detail in the topic file.
- After any write, verify `MEMORY.md` line count and trim if needed.
- Entries with `[pin]` are exempt from all cleanup and staleness logic — never suggest removing them.

### Pinning and unpinning

Use `pin_memory({ topic, pin: true })` to pin. Use `pin_memory({ topic, pin: false })` to unpin.

Use `[pin]` for topics that should never be cleaned up: hardware specs, user identity, core workflows, permanent reference material.

Never remove `[pin]` from an entry unless the user explicitly asks.

### Cross-linking

In a topic file body, use `[[slug]]` to reference a related memory:

```
See also: [[postgresql-setup]], [[user-profile]]
```

Where `slug` is the topic's filename without `.md` (e.g. `postgresql-setup` for `postgresql-setup.md`). A `[[slug]]` that doesn't match an existing file yet is valid — it marks something worth writing later.

## Freshness verification

Before acting on anything named in a memory — a file path, function name, config flag, or external URL — verify it still exists:

- **File path** → `Read` or `Glob` to confirm the file is there
- **Function or symbol** → `grep` for the name in the codebase
- **Config key or flag** → check the relevant config file

A memory that names a specific file or function is a claim made when the memory was written. It may have been renamed, removed, or never merged. Trust what you observe now over what the memory says. If the named thing is gone, update or remove the memory rather than acting on stale information.

## Staleness flags

The plugin stamps `[stale?]` on index entries older than `stale_after_days` (default 180, configurable via `"stale_after_days"` in `memory.jsonc`). The flag appears in the index line, after the date:

```
- [Topic Name](file.md) 2025-11-01T09:53:38+08:00 [stale?] -- summary
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

If the injected `## Global Memory` block contains a truncation warning (`memory truncated`), the index has exceeded either the configured line limit (`max_lines`, default 300) or the hard 50 KB byte cap. Either condition triggers truncation and the same trim procedure below. Steps:

1. Read `MEMORY.md` in full to assess all entries.
2. Identify entries that are candidates for removal. Check in this order:
   - **Skip immediately**: any entry with `[pin]` — never a removal candidate.
   - **Objective (remove without judgment)**: entry points to a topic file that no longer exists on disk; or two entries point to the same filename (keep the one with the more recent date, remove the other). Use `remove_memory` for these.
   - **Conservative judgment (remove only if clearly obsolete)**: topic was session-specific and no longer applies; topic is fully superseded by a newer broader entry. When in doubt, keep the entry. Use `remove_memory` for these.
   - **`[stale?]` entries**: these are prioritised candidates — review them first.
3. If all entries are still valid but the count is high, consolidate: merge two closely related topic files into one using `write_memory`, then `remove_memory` on the now-redundant entry.
4. Topic file content is never deleted — only index lines are removed.
5. Re-read `MEMORY.md` after trimming to confirm it is under the configured limit.

## TUI browser

The optional TUI plugin (`ocl-memory-tui.mjs`, registered in `tui.jsonc`) provides an interactive memory browser at `ctrl+alt+m`. From it you can view, pin/unpin, and remove index entries without an LLM turn.

TUI mutations (pin/unpin, remove) write a `.invalidate` sentinel file to the memory directory (whichever one is active — local or shared). On the next agent interaction, the server plugin detects the sentinel, discards its cache, and re-reads the index from disk. Changes made via the TUI are therefore visible after the next agent turn — not instantly within the current one.

The TUI resolves `shared_dir` the same way the server plugin does — both read `memory.jsonc` through the same shared internal module, so they always agree on which directory (local or `~/.agents/memory/`) is active. The TUI re-reads this fresh every time the browser is opened, so it picks up `shared_dir` changes immediately.

## Cross-tool shared memory (`shared_dir`)

Setting `"shared_dir": true` in `memory.jsonc` moves `MEMORY.md` and topic files to `~/.agents/memory/` — a location other memory-aware tools (e.g. pi's `openpi-memory`) can also read and write, using the same on-disk format. `memory.jsonc` itself always stays local regardless of this setting.

The first time `shared_dir` resolves `true`, existing local memory is merged into the shared directory — copied, never moved. If another tool (e.g. openpi-memory) already wrote there, local entries are merged in rather than skipped: same-name-different-content collisions get renamed with a `-oclm` suffix; identical content is skipped. Originals stay untouched in `~/.config/opencode/memory/`. This full merge scan runs at most once ever per local install — a sentinel file written after the first successful merge short-circuits every later opencode session straight to a single existence check. Toggling `shared_dir` off and back on does not re-run it or reconcile any drift that happened while it was off — treat it as a one-way move. See [docs/shared-directory.md](../../docs/shared-directory.md) for a worked example.

Writes to the shared directory are protected by a cross-process advisory lock (`.lock` file) so this tool and another tool sharing the directory don't corrupt the index with interleaved writes.

## Consolidation

`/memory consolidate` reviews the current conversation for facts that match `always_persist` in `memory.jsonc` but haven't been written yet, calls `write_memory` for each, and writes or updates a `Last Session Recap` topic (`last-session-recap.md`, `mode: "replace"`, unpinned — it's meant to be overwritten every session, not accumulated).

Setting `"consolidate_on_compact": true` in `memory.jsonc` runs the same consolidation automatically after opencode's automatic (threshold-triggered) compaction, replacing opencode's default synthetic "continue" message. To avoid re-scanning the whole conversation, the consolidation turn is seeded with the compaction summary opencode just generated, and it tells the agent to resume any pending work from the summary's "Next Move" section afterwards — so consolidation persists the session's facts without abandoning an in-progress task. Default is `false` — opencode already sends that default continue message on its own; this setting only matters if you want a consolidation pass to run instead. **This only fires on automatic (overflow-triggered) compaction.** Manual `/compact` does not trigger consolidation — run `/memory consolidate` explicitly if you compact manually and want the same effect.

## Persist rules

Your persist rules are in `~/.config/opencode/memory.jsonc` and are injected into your context under `## Memory Rules` on the first turn, every `inject_every_n_turns` turns, and after memory tool calls. Follow them.

If no `## Memory Rules` block is in your context, read `~/.config/opencode/memory.jsonc` directly.
