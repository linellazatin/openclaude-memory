# openclaude-memory

<div align="center">

[![gh stars](https://img.shields.io/github/stars/linellazatin/openclaude-memory?logo=github&color=ffffe0)](https://github.com/linellazatin/openclaude-memory)
[![npm version](https://img.shields.io/npm/v/@openlines/openclaude-memory)](https://www.npmjs.com/package/@openlines/openclaude-memory)
[![npm downloads](https://img.shields.io/npm/dm/@openlines/openclaude-memory?logo=npm&color=cb3837)](https://www.npmjs.com/package/@openlines/openclaude-memory)
[![license](https://img.shields.io/npm/l/@openlines/openclaude-memory)](./LICENSE)

</div>
OPEN. CONFIGURABLE. Global persistent memory for [opencode](https://opencode.ai) sessions. Inspired by Claude Code's auto-memory — your agent remembers what it learns, across every session, globally.

> <div align="center">
>
> ### A [local-first, small, and deterministic SQLite core (FTS5/BM25) for coding-agent memory](https://nanomneme.openlines.dev) is currently in development - which also has an **opencode** adapter. Feel free to check it out, specially if you're already tired of flat-files as memory store (I won't stop you, though).
>
> </div>

>
> ## v0.6.7: request injection and flat-file safety
> - Memory is attached to every model request; filesystem changes refresh the cache automatically.
> - Automatic consolidation queues a `noReply` prompt without waiting on its own running session.
> - Local and shared mutations fail closed on contention; migration locks both directories and respects removals.
> - Topic identity, symlink boundaries, pinned TUI removal, metadata recovery, JSONC literals, repair counts, and failed-write rollback are covered by regressions.
> - 120 smoke tests, real-process shared-writer checks, and a real OpenCode 1.18.34 host check with a local fake model.
>
> ## v0.6.6 — co-tenancy audit fixes (match safety, lock tokens, drift hygiene)
> - `remove_memory`/`pin_memory` now refuse ambiguous partial matches instead of silently mutating the first matching entry; exact names win outright (openpi-memory parity)
> - `.lock` carries a `pid\tts\trand` token: stale reclaim re-verifies the file before unlinking (no two-reclaimer lock clobber), and release is compare-and-delete
> - drift maintenance note no longer counts intentionally-removed (tombstoned) files — it can't get stuck after repeated removals
> - `repair_memory` sanitizes recovered frontmatter timestamps so a corrupted co-tenant file can't forge a `[pin]` onto an index line; summaries are collapsed + capped at 500 chars; consolidation recap is now one canonical topic (`OCL Last Session Recap`)
> - TUI pin/remove match only the parsed entry line, never a line that merely mentions another topic's link; failed carry-over merges now retry within the session
> - 6 new tests (86 → 92)
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

- [How opencode Keeps Memory in Context](docs/memory-injection.md): per-request injection, cache freshness, compaction, and token costs
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

1. **Injection**: OpenCode constructs a fresh system prompt for every model request. The plugin attaches the cached index and behavioral rules under `## Global Memory` and `## Memory Rules` each time, including requests in other sessions and after compaction.
2. **Topic files**: `MEMORY.md` is a concise index (one line per topic). Detail lives in separate topic files (`~/.config/opencode/memory/<topic>.md`), loaded on-demand by the agent when it needs more context.
3. **Native tools**: The plugin registers `write_memory`, `remove_memory`, `pin_memory`, and `repair_memory`. Mutations use a directory lock and atomic file replacement; memory tools invalidate the cache so the next request sees the result.
4. **Auto-writes**: The agent writes to memory proactively — without being asked — when it learns something worth keeping: user preferences, feedback on how to approach work, project constraints, or pointers to external systems. Memories are typed (`user`, `feedback`, `project`, `reference`), and structured entries include a `Why:` + `How to apply:` section so the agent can reason about edge cases, not just recite facts. Reliability varies by model; see [Model compatibility](docs/architecture.md#model-compatibility).
5. **Manual control**: Use `/memory` to view the current index, `/memory <text>` to store a fact immediately, `/memory pin <topic>` to pin an entry, `/memory unpin <topic>` to unpin, `/memory remove <topic>` to remove one, or `/memory consolidate` to review the session for undocumented facts.
6. **Compaction**: The plugin forces a fresh disk read into the compaction context. When `consolidate_on_compact` is enabled and OpenCode invokes its automatic continuation hook, it queues consolidation with `noReply: true` and retains native continuation on API failure. Manual `/compact` does not invoke this hook; an automatic compaction replay path can bypass it too.
7. **Bootstrap**: `memory.jsonc` is created on first use without replacing a racing creator's config. A missing index is returned in memory; `MEMORY.md` is materialized only by a locked mutation or migration.

The cache checks file identity, size, and nanosecond timestamps before reuse, so manual edits, co-tenant writes, TUI edits, and `shared_dir` changes are picked up on the next cache check. `inject_every_n_turns` retains its name but now controls a forced disk refresh every N model requests, not whether memory is injected. It does not reduce prompt-token costs.

See [How opencode Keeps Memory in Context](docs/memory-injection.md) for request construction, cache freshness, and compaction details.

## Native tools

The plugin registers four tools that the agent calls directly. These replace raw Write/Edit file operations for all memory writes.

| Tool | Args | What it does |
|---|---|---|
| `write_memory` | `topic`, `content`, `summary`, `pin`, `mode` | Creates or updates a topic. `append` adds a dated section; `replace` replaces the body. Both refresh `name`, `description`, and `last_updated`, preserve `created` and other frontmatter, and update the index. Summary is sanitized and capped at 500 characters. Native calls supply all fields; direct JS calls default to `pin: false`, `mode: "append"`. |
| `remove_memory` | `topic` | Removes the index entry. A partial `topic` must match exactly one entry — an exact name wins, multiple substring matches are refused with a candidate list. Refuses if the entry is pinned. Topic file is preserved on disk and its filename is tombstoned in `.ocl-removed` so `/memory repair` will not resurrect it. |
| `pin_memory` | `topic`, `pin` (bool) | Pins (`true`) or unpins (`false`) an index entry. Same exact-wins / ambiguous-refuses matching as `remove_memory`. Pinned entries are never flagged as stale and cannot be removed. |
| `repair_memory` | — | Additively re-indexes topic `.md` files present on disk but missing from `MEMORY.md` (marked `[stale?]`, dated from frontmatter). Idempotent; never deletes or reorders. **Skips any file tombstoned by `remove_memory`**, so intentional removals stay gone. |

Committed writes, removals, and pin changes maintain the index: unsafe or missing files are dropped, duplicate filenames keep the newest full timestamp and preserve pins, and stale flags heal when refreshed, pinned, or disabled. Repair remains additive-only. Reserved `MEMORY.md`, non-markdown names, control characters, directories, and symlink targets are refused. See [Configuration & Index Reference](docs/configuration.md).

## Consolidation

`/memory consolidate` asks the agent to review the current conversation for facts matching `always_persist` in `memory.jsonc` that haven't been written yet, call `write_memory` for each, and write or update a `OCL Last Session Recap` topic (`ocl-last-session-recap.md`, `mode: "replace"`, unpinned — it's overwritten every session, not accumulated).

Set `"consolidate_on_compact": true` in `memory.jsonc` to run the same consolidation automatically after opencode's automatic (threshold-triggered) compaction. When enabled, this replaces opencode's default synthetic "continue" message with a consolidation turn instead. Rather than re-scanning the whole conversation, the consolidation turn is seeded with the compaction summary opencode just generated — one fewer full-conversation scan — and it tells the agent to resume any pending work from the summary's "Next Move" section afterwards, so consolidation does not abandon an in-progress task. If the summary can't be fetched, it falls back to a full-conversation scan. Default is `false` — opencode already sends that continue message on its own; this setting only matters if you want consolidation to run in its place.

**Known limitation:** `consolidate_on_compact` only fires on **automatic** compaction (overflow-triggered), not on manual `/compact`. See the [FAQ](docs/faq.md) for the confirmed source-level reason and the workaround.

## Customising persist rules and config

`~/.config/opencode/memory.jsonc` is auto-created on first run with sensible defaults — persist rules (`always_persist`, `never_persist`, `always_ask`) plus config scalars (`max_lines`, `stale_after_days`, `inject_every_n_turns`, `shared_dir`, `consolidate_on_compact`). Edit it directly at any time; changes take effect on the next cache refresh.

See [Configuration & Index Reference](docs/configuration.md) for the full `memory.jsonc` example and a field-by-field explanation of every option.

**Upgrading from a pre-0.6.0 install?** Config used to live at `~/.config/opencode/memory/RULES.jsonc`. It migrates automatically to the new `memory.jsonc` location — see the [FAQ](docs/faq.md) for what exactly happens to your old files.

## Cross-tool shared memory (`shared_dir`)

Setting `shared_dir: true` uses `~/.agents/memory/`, shared with compatible tools such as [openpi-memory](https://github.com/linellazatin/openpi-memory). Config remains local. Cooperating mutations lock the directory and atomically replace individual files; operations are not multi-file crash transactions.

**Carry-over is one-way, not continuous synchronization.** Path changes are detected, but a completed migration does not re-run or reconcile inactive snapshots. See [shared storage](docs/shared-directory.md) and the [FAQ](docs/faq.md).

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

Restart opencode to load the updated plugins and skill. `memory.jsonc` is created automatically; the empty memory index is injected immediately and written to disk on the first locked mutation. The server lifecycle has been verified on OpenCode 1.18.34 with a local fake model; TUI API contracts and mutation behavior are covered separately.

Once installed:

- Press `ctrl+alt+m` to open the **"Memory Browser"**
- Arrow keys navigate the list; typing filters by topic name
- Select a topic to view its content, pin/unpin it, or remove it from the index (topic file preserved on disk)

The TUI plugin reads and writes `MEMORY.md` directly. Pin/unpin/remove are instant — no model involved.

### Update

To select a release explicitly, use a published version specifier such as `@openlines/openclaude-memory@<version>` in both plugin arrays and restart OpenCode. Bare package names resolve through OpenCode's `latest` package manager path; cache refresh behavior belongs to the installed OpenCode release. Local-path installs load this checkout after restart.

See [System Compatibility](docs/architecture.md#system-compatibility) for supported platforms and version requirements.

## Verification

Run `npm test` for smoke tests and two real concurrent OpenCode writers. Run `npm run test:host` with `opencode` installed for the isolated real-server check; it uses a local fake model and temporary memory storage. To check the sibling implementation, run `node tests/shared-store-test.mjs /absolute/path/to/openpi-memory/extensions/memory-core.mjs`. Syntax-check each `.opencode/plugins/*.mjs` and `tests/*.mjs` file with `node --check`.

## License

MIT
