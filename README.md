# openclaude-memory

[![npm version](https://img.shields.io/npm/v/@openlines/openclaude-memory)](https://www.npmjs.com/package/@openlines/openclaude-memory)
[![license](https://img.shields.io/npm/l/@openlines/openclaude-memory)](./LICENSE)

OPEN. CONFIGURABLE. Global persistent memory for [opencode](https://opencode.ai) sessions. Inspired by Claude Code's auto-memory — your agent remembers what it learns, across every session, globally.

>
> ## v0.6.2 — bugfixes & hardening
> - filename slug collisions no longer silently merge two topics into one file
> - `stripJsonc` no longer breaks on `//` in config values (URLs etc) — now warns instead of silently resetting to defaults
> - memory tools reject bad/missing args cleanly instead of throwing
> - closed a path-traversal gap on filenames read back from `MEMORY.md`
> - 17 new tests (48 → 65), incl. real multi-process lock contention, byte-cap truncation, and the `-oclm-2` collision fallback
>
> ## v0.6.1 HOTFIX on shared_dir
> - **`shared_dir` carry-over now merges** instead of skipping when the shared dir already has content from another memory system of ours (e.g. openpi-memory wrote first) — collisions resolved by content comparison, differing files get a `-oclm` suffix
>
> ## v0.6.0 - MAJOR structural change (shared_dir, consolidation, config relocation)
> - config relocated: `~/.config/opencode/memory/RULES.jsonc` → `~/.config/opencode/memory.jsonc` (legacy installs migrate automatically, old file kept as `.bak`)
> - `shared_dir` (opt-in): move `MEMORY.md` + topic files to `~/.agents/memory/` so our sibling tool (e.g. [openpi-memory](https://github.com/linellazatin/openpi-memory)) can share the same memory store — cross-process file lock + atomic writes included; the TUI browser (`ctrl+alt+m`) follows it too
> - `/memory consolidate` + `consolidate_on_compact` : auto only :( - see [FAQ](docs/faq.md) ... reviews the session for undocumented facts and writes them, plus a session recap
> - bumped defaults: `max_lines` 200 → 300, byte cap 25 KB → 50 KB
> - 22 new tests (26 → 48)
>
> see [CHANGELOG](CHANGELOG.md) for more details

## Table of contents

- [Why](#why)
- [How it works](#how-it-works)
- [Native tools](#native-tools)
- [Consolidation](#consolidation)
- [Customising persist rules and config](#customising-persist-rules-and-config)
- [Cross-tool shared memory](#cross-tool-shared-memory-shared_dir)
- [Installation and Update](#installation-and-update)

**Docs — deeper dives, not needed to get started:**

- [How opencode Keeps Memory in Context](docs/memory-injection.md) — why the injected index persists in the system prompt for the whole session, and what periodic re-injection actually refreshes
- [Configuration & Index Reference](docs/configuration.md) — full `memory.jsonc` reference, index metadata format, staleness flagging, cap handling and remediation
- [Shared Storage Across Tools (shared_dir)](docs/shared-directory.md) — the opt-in `~/.agents/memory/` migration, fresh-install and upgrade walkthroughs
- [Architecture & Internals](docs/architecture.md) — plugin file layout, scope, system compatibility, token overhead, model compatibility
- [Known Limitations & FAQ](docs/faq.md) — watch-outs, especially around `shared_dir` toggling and the v0.6.0 config relocation

## Why

I built this because I genuinely like how Claude Code handles memory: no complex algorithms, no external LLM for heavy lifting, no vector databases. It just works — the agent reads a markdown file and acts on it. Simple, transparent, effective.

I also wanted something local-first. My memories and notes stay on my machine, in plain markdown files I can read, edit, and audit at any time. No cloud sync, no embeddings pipeline, no black-box retrieval. If I want to know what the agent remembers, I open a file.

When something worth remembering happens (a bug fixed, a config discovered, a command identified), the agent writes it to a structured markdown memory store — or you tell it to. The next session, that context is already there — injected automatically into the system prompt before the first message.

But this project wasn't born because I wanted to reinvent memory systems. It was born out of frustration.

Over the past several months, I experimented with nearly every approach I could find: vector databases, embedding models, external memory services, MCP memory servers, and LLM-powered memory management. Some were incredibly clever. Some were feature-rich. But almost all of them came with trade-offs that didn't fit how I work.

Running a separate LLM just to decide whether a memory should be saved felt wasteful. Maintaining embedding models and vector indexes consumed resources I'd rather dedicate to the coding model itself. I found myself spending more time configuring the memory system than actually using it.

I also discovered that more intelligence didn't always mean better memory. During my own testing, I audited memories produced by automated systems and found that many retained facts were incomplete, misleading, or simply wrong. If the memory layer itself isn't trustworthy, every future conversation starts from a weaker foundation.

Eventually I asked myself a simple question:

> Why does remembering something require another AI model?

For the kinds of things I actually wanted to remember—project architecture, debugging notes, shell commands, configuration quirks, design decisions—the answer was: it doesn't.

A markdown file is deterministic. It's searchable with Git. It can be reviewed in code reviews. It survives model changes, provider changes, and framework changes. Most importantly, it never hides what the agent knows.

So instead of building another "AI memory," I built a memory system that stays out of the way.

- No embeddings.
- No vector databases.
- No background services.
- No hidden retrieval algorithms.

Just files, structure, and an agent that knows where to look.

> If you've ever spent hours configuring a sophisticated memory stack only to realize you just wanted your coding agent to remember yesterday's bug fix, this project is for you.

## How it works

1. **Injection**: On the first turn of a session, the plugin reads `~/.config/opencode/memory/MEMORY.md` and `memory.jsonc` into an in-process cache and injects the contents into the system prompt under `## Global Memory` and `## Memory Rules` headers. Injection then repeats every `inject_every_n_turns` turns (default: 5) and immediately after any memory tool mutation, not to keep memory present (it persists in the system prompt for the whole session automatically) but to pick up external edits to `MEMORY.md` without re-reading disk every turn.
2. **Topic files**: `MEMORY.md` is a concise index (one line per topic). Detail lives in separate topic files (`~/.config/opencode/memory/<topic>.md`), loaded on-demand by the agent when it needs more context.
3. **Native tools**: The plugin registers `write_memory`, `remove_memory`, and `pin_memory` tools. The agent calls these instead of raw file operations — the plugin guarantees consistent format, frontmatter, and index maintenance every time. After each tool call the cache is invalidated and a dirty flag is set, so the next turn re-injects the updated index.
4. **Auto-writes**: The agent writes to memory proactively — without being asked — when it learns something worth keeping: user preferences, feedback on how to approach work, project constraints, or pointers to external systems. Memories are typed (`user`, `feedback`, `project`, `reference`), and structured entries include a `Why:` + `How to apply:` section so the agent can reason about edge cases, not just recite facts. Reliability varies by model; see [Model compatibility](docs/architecture.md#model-compatibility).
5. **Manual control**: Use `/memory` to view the current index, `/memory <text>` to store a fact immediately, `/memory pin <topic>` to pin an entry, `/memory unpin <topic>` to unpin, `/memory remove <topic>` to remove one, or `/memory consolidate` to review the session for undocumented facts.
6. **Compaction**: When context compression runs, the plugin forces a fresh disk read and injects the current memory state into the compaction context, ensuring memory survives the compaction cleanly. The injection counter is also reset so the first turn after compaction re-injects the index. If `consolidate_on_compact` is enabled, opencode's automatic post-compaction continue message is replaced with a consolidation pass — seeded with the compaction summary and told to resume pending work afterwards. Note: this only applies to **automatic** compaction — manual `/compact` does not trigger consolidation automatically.
7. **Bootstrap**: On first run, the plugin creates `MEMORY.md` and `memory.jsonc` automatically. Nothing to set up.

> **Note:** If you edit `MEMORY.md` or `memory.jsonc` manually between turns, the change will not be reflected until the next tool call, the next periodic re-injection turn, or a compaction event. This is an intentional trade-off to avoid per-turn disk reads.

See [How opencode Keeps Memory in Context](docs/memory-injection.md) for the full breakdown of why the injected index persists in the system prompt for the whole session, and what periodic re-injection actually refreshes.

## Native tools

The plugin registers three tools that the agent calls directly. These replace raw Write/Edit file operations for all memory writes.

| Tool | Args | What it does |
|---|---|---|
| `write_memory` | `topic`, `content`, `summary`, `pin?`, `mode?` | Creates a new topic file with YAML frontmatter, or updates an existing one. `mode: "append"` (default) adds content under a new dated heading; `mode: "replace"` overwrites the body while preserving frontmatter. Upserts the `MEMORY.md` index entry automatically. |
| `remove_memory` | `topic` | Removes the index entry (case-insensitive match). Refuses if the entry is pinned. Topic file is preserved on disk. |
| `pin_memory` | `topic`, `pin` (bool) | Pins (`true`) or unpins (`false`) an index entry. Pinned entries are never flagged as stale and cannot be removed. |

After every tool call that touches `MEMORY.md`, the plugin runs an index maintenance pass: removes orphaned entries (file no longer on disk), removes duplicates (keeps the more recent), and stamps or removes `[stale?]` flags. See [Configuration & Index Reference](docs/configuration.md) for the full index format and staleness rules.

## Consolidation

`/memory consolidate` asks the agent to review the current conversation for facts matching `always_persist` in `memory.jsonc` that haven't been written yet, call `write_memory` for each, and write or update a `Last Session Recap` topic (`last-session-recap.md`, `mode: "replace"`, unpinned — it's overwritten every session, not accumulated).

Set `"consolidate_on_compact": true` in `memory.jsonc` to run the same consolidation automatically after opencode's automatic (threshold-triggered) compaction. When enabled, this replaces opencode's default synthetic "continue" message with a consolidation turn instead. Rather than re-scanning the whole conversation, the consolidation turn is seeded with the compaction summary opencode just generated — one fewer full-conversation scan — and it tells the agent to resume any pending work from the summary's "Next Move" section afterwards, so consolidation does not abandon an in-progress task. If the summary can't be fetched, it falls back to a full-conversation scan. Default is `false` — opencode already sends that continue message on its own; this setting only matters if you want consolidation to run in its place.

**Known limitation:** `consolidate_on_compact` only fires on **automatic** compaction (overflow-triggered), not on manual `/compact`. See the [FAQ](docs/faq.md) for the confirmed source-level reason and the workaround.

## Customising persist rules and config

`~/.config/opencode/memory.jsonc` is auto-created on first run with sensible defaults — persist rules (`always_persist`, `never_persist`, `always_ask`) plus config scalars (`max_lines`, `stale_after_days`, `inject_every_n_turns`, `shared_dir`, `consolidate_on_compact`). Edit it directly at any time; changes take effect on the next cache refresh.

See [Configuration & Index Reference](docs/configuration.md) for the full `memory.jsonc` example and a field-by-field explanation of every option.

**Upgrading from a pre-0.6.0 install?** Config used to live at `~/.config/opencode/memory/RULES.jsonc`. It migrates automatically to the new `memory.jsonc` location — see the [FAQ](docs/faq.md) for what exactly happens to your old files.

## Cross-tool shared memory (`shared_dir`)

Setting `"shared_dir": true` in `memory.jsonc` moves `MEMORY.md` and topic files to `~/.agents/memory/` — a location other memory-aware tools can also read and write, using the same on-disk format (e.g. [openpi-memory](https://github.com/linellazatin/openpi-memory), the pi.dev port of this project). `memory.jsonc` itself always stays local regardless of this setting. Writes are protected by a cross-process advisory lock and applied atomically.

**This is a one-way migration, not a togglable setting** — see [Shared Storage Across Tools](docs/shared-directory.md) for the full mechanics, fresh-install and upgrade walkthroughs, and the [FAQ](docs/faq.md) for the biggest watch-out around toggling it off and back on.

The TUI memory browser (`ctrl+alt+m`) follows `shared_dir` too — both plugins resolve the active directory through the same shared internal module.

## Installation and Update

### Install

Add to your `~/.config/opencode/opencode.json` (or `opencode.jsonc`) `plugin` array:

```jsonc
{
  "plugin": [
    "@openlines/openclaude-memory"
  ]
}
```
**Via local path (development — works without publishing):**

```jsonc
{
  "plugin": [
    "/absolute/path/to/openclaude-memory"
  ]
}
```

The TUI plugin adds an interactive, arrow-key-navigable memory browser — no LLM turn required. Register to `~/.config/opencode/tui.jsonc`.

```jsonc
{
  "plugin": [
    "@openlines/openclaude-memory"
  ]
}
```
**Via local path (development — works without publishing):**

```jsonc
{
  "plugin": [
    "/absolute/path/to/openclaude-memory"
  ]
}
```

Restart opencode. On the first chat turn of the next session, `~/.config/opencode/memory/MEMORY.md` and `~/.config/opencode/memory.jsonc` will be created automatically, and both `## Global Memory` and `## Memory Rules` blocks will appear in the agent's context. No manual configuration required.

Once installed:

- Press `ctrl+alt+m` to open the **"Memory Browser"**
- Arrow keys navigate the list; typing filters by topic name
- Select a topic to view its content, pin/unpin it, or remove it from the index (topic file preserved on disk)

The TUI plugin reads and writes `MEMORY.md` directly. Pin/unpin/remove are instant — no model involved.

### Update

opencode resolves `@latest` once at first install and caches it permanently — it does not re-check npm on restart. To update to a newer version, delete the cached package and restart:

```bash
rm -rf ~/.cache/opencode/packages/@openlines/openclaude-memory
rm -rf ~/.cache/opencode/packages/@openlines/openclaude-memory@latest
```

opencode may create one or both directories depending on how the specifier was resolved. Delete whichever exists, then restart — opencode will fetch the newest published version on next start.

See [System Compatibility](docs/architecture.md#system-compatibility) for supported platforms and version requirements.

## License

MIT
