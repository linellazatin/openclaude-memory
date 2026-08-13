# openclaude-memory

[![npm version](https://img.shields.io/npm/v/@openlines/openclaude-memory)](https://www.npmjs.com/package/@openlines/openclaude-memory)
[![license](https://img.shields.io/npm/l/@openlines/openclaude-memory)](./LICENSE)

OPEN. CONFIGURABLE. Global persistent memory for [opencode](https://opencode.ai) sessions. Inspired by Claude Code's auto-memory — your agent remembers what it learns, across every session, globally.

> ## v0.5.3 - README update only - no struct/function changes
> - added new section on `how opencode handles memory` - which is a fairly nice read, considering I'm new in these kinds of stuff
> - bumped up minor version to push the above new section (with some statement re-alignments in README as well) to the public; this reframes what `inject_every_n_turns` actually does
> - will probably stack a few updates here, if they're as short as these 2 here
> 
> ## v0.5.2 - Quick clean-up and updates after hotfix (sorry)
> - did some code clean-ups (most of which is for the migration function from legacy .md config to .jsonc)
> - added some caching refresh after index file changes (useful for next agent turn)
> - fixed SKILL description, clarified memory types, added references to new TUI features
> - added 8 test cases, covering mostly index maintenance
> - will add super short updates here moving forward
> 
> see [CHANGELOG.md](CHANGELOG.md) for more details

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

## How opencode keeps memory in context

A common misconception: that the injected memory index would become "stale" in context as the conversation grows. This is not how opencode works.

### System prompt persistence

opencode builds a system prompt at the start of each session. When this plugin fires its `experimental.chat.system.transform` hook on turn 1, it pushes the `## Global Memory` and `## Memory Rules` blocks into `output.system`. That system prompt is **fixed for the life of the session** — opencode sends it on every LLM call. The agent has the memory index in context on turn 1, turn 10, turn 50. It never disappears mid-session.

There is no token overhead per turn from persistence — the system prompt is part of the request structure, not the conversation messages. You are not paying to "re-send" it each turn; opencode handles this at the API level.

### What re-injection actually does

The plugin re-injects memory on three conditions (not just turn 1):

1. **First turn** — cold load and initial injection.
2. **After any memory tool call** — `write_memory`, `remove_memory`, or `pin_memory` mutate `MEMORY.md`. The dirty flag is set and the next turn injects the updated index so the agent sees the change it just made.
3. **Every `inject_every_n_turns` turns** (default: 5) — the plugin re-reads `MEMORY.md` from disk and re-injects. This is **not** to keep memory present (it already is); it is to pick up **external edits** — manual edits to `MEMORY.md`, changes made via the TUI browser, or edits from another process.

If you never edit memory files manually and only use memory tools, condition 3 is mostly a no-op. The index that was injected on turn 1 is already current.

### Compaction

When opencode triggers automatic context compaction (context overflow prevention), it fires the `experimental.session.compacting` hook. The plugin:

1. Force-reads `MEMORY.md` fresh from disk and pushes it into `output.context` — the compaction summary includes current memory state.
2. Resets `_injectedOnce`, `_dirty`, and `_turnCount` to zero.

After compaction, opencode replaces the agent's context window. The first turn of the new context re-injects memory into the fresh system prompt — the same as session start. Memory does not get lost across compaction.

### Summary

| Scenario | Memory in context? |
|---|---|
| Turn 1 | Injected for the first time |
| Turn 2–4 | Still present via system prompt (no re-injection needed) |
| Turn 5 (default N=5) | Re-injected from disk (freshness check, not presence) |
| After `write_memory` / `remove_memory` / `pin_memory` | Re-injected with updated content |
| After TUI browser edit | Re-injected on next periodic turn or tool call |
| After context compaction | Re-injected on first post-compaction turn |

The `inject_every_n_turns` config value controls how quickly external edits are reflected — it has no effect on whether memory is present. Raise it to save tokens on long sessions; lower it if you frequently edit `MEMORY.md` outside the agent.

## How it works

1. **Injection**: On the first turn of a session, the plugin reads `~/.config/opencode/memory/MEMORY.md` and `RULES.jsonc` into an in-process cache and injects the contents into the system prompt under `## Global Memory` and `## Memory Rules` headers. Injection then repeats every `inject_every_n_turns` turns (default: 5) and immediately after any memory tool mutation, not to keep memory present (it persists in the system prompt for the whole session automatically) but to pick up external edits to `MEMORY.md` without re-reading disk every turn.
2. **Topic files**: `MEMORY.md` is a concise index (one line per topic). Detail lives in separate topic files (`~/.config/opencode/memory/<topic>.md`), loaded on-demand by the agent when it needs more context.
3. **Native tools**: The plugin registers `write_memory`, `remove_memory`, and `pin_memory` tools. The agent calls these instead of raw file operations — the plugin guarantees consistent format, frontmatter, and index maintenance every time. After each tool call the cache is invalidated and a dirty flag is set, so the next turn re-injects the updated index.
4. **Auto-writes**: The agent writes to memory proactively — without being asked — when it learns something worth keeping: user preferences, feedback on how to approach work, project constraints, or pointers to external systems. Memories are typed (`user`, `feedback`, `project`, `reference`), and structured entries include a `Why:` + `How to apply:` section so the agent can reason about edge cases, not just recite facts. Reliability varies by model; see [Model compatibility](#model-compatibility).
5. **Manual control**: Use `/memory` to view the current index, `/memory <text>` to store a fact immediately, `/memory pin <topic>` to pin an entry, `/memory unpin <topic>` to unpin, or `/memory remove <topic>` to remove one.
6. **Compaction**: When context compression runs, the plugin forces a fresh disk read and injects the current memory state into the compaction context, ensuring memory survives the compaction cleanly. The injection counter is also reset so the first turn after compaction re-injects the index.
7. **Bootstrap**: On first run, the plugin creates `MEMORY.md` and `RULES.jsonc` automatically. Nothing to set up.

> **Note:** If you edit `MEMORY.md` or `RULES.jsonc` manually between turns, the change will not be reflected until the next tool call, the next periodic re-injection turn, or a compaction event. This is an intentional trade-off to avoid per-turn disk reads.

## Native tools

The plugin registers three tools that the agent calls directly. These replace raw Write/Edit file operations for all memory writes.

| Tool | Args | What it does |
|---|---|---|
| `write_memory` | `topic`, `content`, `summary`, `pin?`, `mode?` | Creates a new topic file with YAML frontmatter, or updates an existing one. `mode: "append"` (default) adds content under a new dated heading; `mode: "replace"` overwrites the body while preserving frontmatter. Upserts the `MEMORY.md` index entry automatically. |
| `remove_memory` | `topic` | Removes the index entry (case-insensitive match). Refuses if the entry is pinned. Topic file is preserved on disk. |
| `pin_memory` | `topic`, `pin` (bool) | Pins (`true`) or unpins (`false`) an index entry. Pinned entries are never flagged as stale and cannot be removed. |

After every tool call that touches `MEMORY.md`, the plugin runs an index maintenance pass: removes orphaned entries (file no longer on disk), removes duplicates (keeps the more recent), and stamps or removes `[stale?]` flags.

## Customising persist rules and config

`~/.config/opencode/memory/RULES.jsonc` is auto-created on first run with sensible defaults. Edit it directly to add, remove, or modify rules, and to configure the index limits:

```jsonc
{
  // What to always persist
  "always_persist": [
    "Any issue solved or fixed",
    "Server or infrastructure configuration discovered or changed",
    "Reusable commands or workflows identified",
    "Hardware, model, or environment facts learned"
  ],
  // What to never persist
  "never_persist": [
    "Code patterns, conventions, or architecture derivable from reading the codebase",
    "Git history — use git log/blame instead",
    "Debugging fix recipes — the fix is in the code; the commit message has the context",
    "Ephemeral in-session task state (todos, current work-in-progress)",
    "Anything already documented in AGENTS.md, CLAUDE.md, or project config files",
    "Large code blocks — summarize the insight or link to the file path instead"
  ],
  // Always ask before persisting (non-overridable)
  "always_ask": [
    "Credentials, tokens, API keys",
    "Personal data",
    "Anything the user marks as private or ephemeral"
  ],
  // max_lines: valid range 50–500
  "max_lines": 200,
  // stale_after_days: 0 = disable age flagging
  "stale_after_days": 180,
  // inject_every_n_turns: re-inject memory every N user prompts; 1 = every prompt
  "inject_every_n_turns": 5
}
```

Change `"max_lines"` to set a custom index size limit. The plugin clamps values to the valid range `[50, 500]`. If the key is absent, the default of 200 is used.

Change `"stale_after_days"` to control when entries are flagged as stale. Set to `0` to disable age flagging entirely.

Change `"inject_every_n_turns"` to tune how often the memory index is re-injected into the system prompt. The default of `5` means the index is refreshed on turn 1, turn 6, turn 11, and so on — plus immediately after any memory tool call. Set to `1` to re-inject every turn. Higher values save tokens; lower values pick up external edits to `MEMORY.md` more quickly. The minimum is `1` — setting `0` is silently clamped to `1` (not treated as "disable"). To effectively disable periodic re-injection, set a very high value such as `9999`; re-injection will still fire after any memory tool mutation.

The plugin injects this file into every session's system prompt under a `## Memory Rules` header. `RULES.jsonc` is the single source of truth for persist rules — no other configuration needed.

**Note:** The "Always ask before persisting" section is a strong convention. The agent will always prompt before storing credentials or personal data.

## Index metadata

Each entry in `MEMORY.md` can carry optional metadata fields:

```
- [Topic Name](file.md) [pin] YYYY-MM-DDTHH:MM:SS±HH:MM [stale?] -- one-line summary
```

| Field | Meaning |
|---|---|
| `[pin]` | Permanent entry — never a cleanup candidate and never flagged as stale. Use for hardware specs, user identity, core workflows. |
| `YYYY-MM-DDTHH:MM:SS±HH:MM` | ISO 8601 datetime (local timezone) the topic file was last written to. Maintained automatically by `write_memory`. |
| `[stale?]` | Stamped by the plugin when the entry's date exceeds `stale_after_days`. Removed automatically when the topic is updated. See [Staleness](#staleness). |

## Staleness

The plugin stamps `[stale?]` on index entries older than `stale_after_days` (default: 180 days) during any tool call that touches `MEMORY.md`. The file is never modified on session load — only on explicit tool use.

**Rules:**
- `[pin]` entries are never flagged, regardless of age.
- Entries with no date are never flagged.
- The flag self-heals: call `write_memory` on a stale topic and the date advances; the plugin removes `[stale?]` automatically on the next maintenance pass.

**What to do with `[stale?]` entries:**
- Ask the user if the topic is still relevant before acting.
- If yes: call `write_memory` to refresh it (flag disappears).
- If no: call `remove_memory` to remove the index entry (topic file preserved).

Set `"stale_after_days": 0` in `RULES.jsonc` to disable age flagging entirely.

## Cap handling

`MEMORY.md` is capped at a configurable line limit (default **200 lines**) and an absolute **25 KB** hard limit. When either limit is exceeded, the plugin truncates the injected content at the configured limit and appends a warning comment to what the agent sees in its context:

```
<!-- memory truncated: MEMORY.md exceeds 200-line limit; shorten the index -->
```

The file on disk is untouched. The agent sees the warning and is responsible for trimming the index. The remediation procedure it follows (defined in `SKILL.md`):

1. Read `MEMORY.md` in full to assess all entries.
2. Identify entries that are candidates for removal:
   - **Skip**: any entry with `[pin]` — never a removal candidate.
   - **Remove without judgment**: orphaned entries (topic file missing) or duplicates. Use `remove_memory`.
   - **`[stale?]` entries**: prioritised candidates — review these first.
   - **Remove only if clearly obsolete**: topic was session-specific and no longer applies; topic is fully superseded by a newer broader entry. When in doubt, keep the entry. Use `remove_memory`.
3. If all entries are still valid but the count is high, consolidate: merge two closely related topic files into one using `write_memory`, then `remove_memory` on the now-redundant entry.
4. Topic file content is never deleted — only index lines are removed.
5. Re-read `MEMORY.md` after trimming to confirm it is under the configured limit.

The cap exists to keep per-turn token overhead bounded. At the default 200 lines, the index alone costs ~4,300–4,900 tokens. A well-maintained index should stay well under 100 entries for typical personal use.

## Plugin architecture

```
openclaude-memory/
├── CHANGELOG.md                        # release history
├── package.json                        # npm package manifest
├── .opencode/
│   ├── plugins/ocl-memory.mjs          # server plugin — tools, system prompt injection
│   ├── plugins/ocl-memory-tui.mjs      # TUI plugin — interactive memory browser
│   └── command/memory.md               # /memory slash command definition
└── skills/
    └── memory/SKILL.md                 # agent instructions for reading/writing memory
```

| File | Role |
|---|---|
| `ocl-memory.mjs` | Loads `MEMORY.md` and `RULES.jsonc` into an in-process cache on first turn; injects into system prompt. Memory persists in the system prompt for the whole session — re-injection fires after tool mutations and every `inject_every_n_turns` turns (default: 5) to pick up external edits, not to keep memory present. Invalidates cache and sets dirty flag after every tool call. Forces fresh read and resets injection state on compaction. Registers `write_memory`, `remove_memory`, `pin_memory` tools. Runs index maintenance (orphan removal, duplicate removal, `[stale?]` stamping) after every tool call. Auto-creates files on first run. Caps injection at configured lines / 25 KB. |
| `ocl-memory-tui.mjs` | TUI plugin — registered in `tui.jsonc`. Registers `ctrl+alt+m` keybinding. Provides an interactive, arrow-key-navigable browser over the memory index — view topic content, pin/unpin, and remove entries. All actions are direct file I/O; no LLM turn required. |
| `memory.md` (command) | `/memory` shows the index (retained - with LLM turn). `/memory <text>` stores a fact via `write_memory`. `/memory pin <topic>` pins via `pin_memory`. `/memory unpin <topic>` unpins. `/memory remove <topic>` removes via `remove_memory`. |
| `SKILL.md` | Loaded on-demand by the agent — full instructions for memory tools, format, index discipline, staleness handling, and cap remediation. |

## Scope

**In scope:**

- Flat markdown persistence (`MEMORY.md` + topic files)
- System prompt injection on first turn, every `inject_every_n_turns` turns (default: 5), and immediately after any memory tool mutation
- Native plugin tools for write, remove, and pin operations
- TUI memory browser (`ctrl+alt+m`): interactive, arrow-key-navigable browser
- Automatic writes triggered by agent activity (issues solved, infra discovered, commands identified, hardware/model facts)
- Manual `/memory` command for show, explicit storage, pin, unpin, and remove
- Auto-creation of `MEMORY.md` and `RULES.jsonc` on first run
- Cap handling with truncation warning when index exceeds configured limit (default 200 lines) or 25 KB
- Configurable `max_lines` and `stale_after_days` via `RULES.jsonc`
- Index metadata: `[pin]` flag, `YYYY-MM-DDTHH:MM:SS±HH:MM` ISO datetime, `[stale?]` staleness flag per entry
- Index maintenance: orphan removal, duplicate removal, staleness flagging on tool calls

**Out of scope:**

- Semantic or fuzzy search across memories
- Custom MCP/remote/local server (the agent uses plugin-registered tools)
- Encryption or sync
- Per-project memory (this is global only)
- Real-time staleness monitoring (flags are stamped on tool calls, not on session load)

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

Restart opencode. On the first chat turn of the next session, `~/.config/opencode/memory/MEMORY.md` and `RULES.jsonc` will be created automatically, and both `## Global Memory` and `## Memory Rules` blocks will appear in the agent's context. No manual configuration required.

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

## System Compatibility


| Requirement | Notes                                                                                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| opencode    | >= 1.4.3                                                                                                                                                                                           |
| Node.js     | >= 18 (ESM,`fs`, `os`, `path` stdlib only)                                                                                                                                                         |
| Linux       | Full support                                                                                                                                                                                       |
| macOS       | Supported. opencode follows XDG on macOS, so`~/.config/opencode/` is used by default. If your opencode config lives elsewhere, set `XDG_CONFIG_HOME` to the parent of your `opencode/` config dir. |
| Windows     | Not supported                                                                                                                                                                                      |

## Token overhead

The plugin injects the `MEMORY.md` index and rendered `RULES.jsonc` (behavioral rules only, as markdown) into the system prompt on the first turn of each session. Memory then persists in the system prompt automatically for the session — re-injection fires every `inject_every_n_turns` turns (default: 5) to pick up external edits, and immediately after any memory tool mutation to reflect the change just made. All other turns receive no injection. Cost scales with index size, but only pays on turns where injection actually occurs:


| State                                            | Est. tokens / injection |
| ------------------------------------------------ | ----------------------- |
| Fresh install (empty index, default RULES.jsonc) | ~200                    |
| Typical use (10–30 entries, default RULES.jsonc) | ~400–900               |
| Custom RULES.jsonc (typical, 10–20 rules)        | similar to above        |
| At cap (configured limit, default 200 lines)     | ~4,500–5,200           |
| Hard cap (25 KB)                                 | ~6,400                  |

Estimates based on [Claude's tokenizer](https://www.claudetokenizer.com/) averaging 3.5–4 characters per token for markdown prose. Topic files are **not** injected — only the index line — so even a large memory store stays cheap until the index itself grows large. ISO 8601 datetimes in index lines add ~4 tokens/entry vs bare dates. Only the behavioral rule arrays are injected from `RULES.jsonc`; scalar config keys (`max_lines`, `stale_after_days`, `inject_every_n_turns`) are plugin internals and do not appear in the system prompt.

## Disk I/O and injection overhead

Prior to v0.2.0, the plugin read `MEMORY.md` and `RULES.md` from disk on **every turn** and injected both into every system prompt. As of v0.3.0, `RULES.jsonc` replaces `RULES.md` and only the behavioral rule arrays are rendered and injected — scalar config keys are excluded from the system prompt. As of v0.5.0, `write_memory` accepts an optional `mode` parameter (`"append"` | `"replace"`) for overwriting stale content in place.

As of v0.2.0, two complementary optimizations apply (carried forward in v0.3.0):

**1. Disk reads** — both files are loaded once into an in-process cache on first use. The cache is invalidated only when a tool call mutates `MEMORY.md`. A forced fresh read is performed before compaction.

**2. Token injection** — `MEMORY.md` and `RULES.jsonc` are injected into the system prompt on:
  - Turn 1 (session start)
  - Every `inject_every_n_turns` turns thereafter (default: 5 — so turns 1, 6, 11, 16...)
  - Any turn immediately following a memory tool mutation (`write_memory`, `remove_memory`, `pin_memory`)

All other turns receive no injection. Users can tune `inject_every_n_turns` in `RULES.jsonc` — lower values (e.g. `2`) pick up external edits to `MEMORY.md` more quickly; higher values (e.g. `10`) reduce token overhead at the cost of slower refresh. In addition to this, the tool injects current `MEMORY.md` and rendered `RULES.jsonc` content into the compaction context so memory survives context compression cleanly.

> **Note:** TUI memory browser actions (pin/unpin/remove via `ctrl+alt+m`) write `MEMORY.md` directly without going through the server plugin. This bypasses the cache and dirty flag — the same caveat as manual file edits. Changes made via the TUI will not appear in the injected system prompt until the next tool call, the next periodic re-injection turn, or a compaction event.

**Savings per session — default interval of 5 (typical 10–30 entry index, ~400–900 tokens/injection, your mileage may vary):**

| Session | Turns | Tool calls | Injections (before) | Injections (after, N=5) | Tokens saved (est.) |
|---|---|---|---|---|---|
| Read-heavy, 0 writes | 20 | 0 | 20 | 5 | ~6,000–13,500 (75%) |
| Typical, 3 writes | 20 | 3 | 20 | ~7 | ~5,200–11,700 (65%) |
| Write-heavy, 10 writes | 30 | 10 | 30 | ~15 | ~6,000–13,500 (50%) |
| Long session, 5 writes | 100 | 5 | 100 | ~25 | ~30,000–67,500 (75%) |

Injection count formula (default N=5): `ceil(turns / 5) + tool_calls_on_non-interval_turns`. Before: `1 × turns`.

Disk read formula: `reads = 2 (cold load) + 2 × tool_calls`. Before: `2 × turns`.

**Savings at other interval settings (20-turn read-heavy session, 0 writes):**

| `inject_every_n_turns` | Injections | Tokens saved vs every-turn (est.) |
|---|---|---|
| `1` (every turn — original behavior) | 20 | 0% |
| `3` | 7 | ~65% |
| `5` (default) | 5 | ~75% |
| `10` | 2 | ~90% |

Savings are most pronounced in long read-heavy sessions (debugging, exploration, code review) where the agent rarely writes to memory but turns are numerous. For write-heavy sessions the interval matters less since tool mutations trigger injection regardless.

## Model compatibility

The plugin injects plain markdown into the system prompt and registers structured tools — no model-specific features required. Tool calls are more reliable than free-form write instructions, especially on smaller models.

As of mid-2026, capable tool-calling models exist at every size tier. The boundaries that previously separated "small" from "capable" have largely collapsed: Qwen3-8B carries a 131K context window and native tool calling; Gemma 4 E2B (2.3B effective) runs on a phone and still supports native function calling; Nanbeige4.1-3B sustains up to 600 tool-call turns on a 256K context. The tier labels below reflect operational reliability on this plugin's specific workload — structured tool calls against a markdown index — not general model capability.

Where a feature is backed by a plugin tool, the tool guarantees correct format and index integrity regardless of model tier — only the model's decision to call the tool (and what args to pass) varies.

| Feature | Large (20B+, e.g. Qwen3.6-27B, Mistral Small 3.1 24B) | Small-Mid (>7B <20B, e.g. Qwen3-8B, Gemma 4 12B, Llama 3.2 8B) | Compact (<7B, e.g. Qwen3-4B, Gemma 4 E4B, Nanbeige4.1-3B) |
|---|---|---|---|
| `/memory` show index | Reliable | Reliable | Reliable |
| `/memory <text>` store via `write_memory` | Reliable | Reliable | Reliable |
| `/memory pin/unpin <topic>` via `pin_memory` | Reliable | Reliable | Reliable |
| `/memory remove <topic>` via `remove_memory` | Reliable | Reliable | Reliable |
| TUI browser — pin/unpin/remove (`ctrl+alt+m`) | Model-free | Model-free | Model-free |
| Auto-trigger writes (persist rules) | Reliable | Reliable | Usually works |
| Topic/summary quality on auto-writes | Reliable | Reliable | Usually works |
| Date stamping on auto-writes | Plugin-guaranteed | Plugin-guaranteed | Plugin-guaranteed |
| `[pin]` on auto-writes (arg passed correctly) | Reliable | Reliable | Usually works; verify with `/memory` after |
| `[stale?]` flagging and self-healing | Plugin-guaranteed | Plugin-guaranteed | Plugin-guaranteed |

**Representative models by tier (mid-2026):**

| Tier | Examples | Context | Tool calling |
|---|---|---|---|
| Large (20B+) | Qwen3.6-27B, Mistral Small 3.1 24B, Devstral 24B, Gemma 4 31B | 128K–256K | Native |
| Small-Mid (>7B <20B) | Qwen3-8B, Gemma 4 12B, GLM-4-9B, Llama 3.2 8B | 128K–256K | Native |
| Compact (<7B) | Qwen3-4B, Qwen3.1-7B, Gemma 4 E4B (4.5B), Nanbeige4.1-3B, Llama 3.2 3B | 128K–256K | Native |
| Edge/on-device | Gemma 4 E2B (2.3B, 0.8GB mobile), Qwen3-0.6B, LittleLamb 0.3B | 128K | Native |

**Mitigations already in place:**
- Structured tool calls replace free-form write instructions — format, frontmatter, and index integrity are guaranteed by the plugin
- Date stamping is handled by the plugin, not the model — no model tier can get it wrong
- `[stale?]` flagging and orphan/duplicate cleanup run entirely in the plugin
- `/memory pin`, `/memory unpin`, and `/memory remove` are single structured tool calls — reliable even on compact and edge models
- TUI browser pin/unpin/remove (`ctrl+alt+m`) are direct file writes — no model involved at any tier

If you are using an older model, compact, or edge models, `/memory <text>` explicit commands will always be more reliable than auto-trigger writes.

## License

MIT
