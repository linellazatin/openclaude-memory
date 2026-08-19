# Architecture & Internals

[Back to README](../README.md)

## Plugin architecture

```
openclaude-memory/
├── CHANGELOG.md                        # release history
├── package.json                        # npm package manifest
├── .opencode/
│   ├── plugins/ocl-memory.mjs          # server plugin — tools, system prompt injection
│   ├── plugins/ocl-memory-shared.mjs   # shared path/config resolution, locking, atomic writes
│   ├── plugins/ocl-memory-tui.mjs      # TUI plugin — interactive memory browser
│   └── command/memory.md               # /memory slash command definition
└── skills/
    └── memory/SKILL.md                 # agent instructions for reading/writing memory
```

| File | Role |
|---|---|
| `ocl-memory.mjs` | Loads `MEMORY.md` and `memory.jsonc` into an in-process cache on first turn; injects into system prompt. Memory persists in the system prompt for the whole session — re-injection fires after tool mutations and every `inject_every_n_turns` turns (default: 5) to pick up external edits, not to keep memory present. Invalidates cache and sets dirty flag after every tool call. Forces fresh read and resets injection state on compaction. Registers `write_memory`, `remove_memory`, `pin_memory` tools — all 3 validate their required arguments (clean error instead of an unhandled exception) and treat `pin` as a strict boolean. `write_memory` falls back to a numeric-suffixed filename if a new topic's slug collides with an unrelated existing file. Runs index maintenance (orphan removal, duplicate removal, unsafe-filename removal, `[stale?]` stamping) after every tool call. Auto-creates files on first run; migrates legacy `RULES.jsonc` automatically. Caps injection at configured lines / 50 KB. Supports `shared_dir` (cross-process lock + atomic writes + one-time carry-over) and `consolidate_on_compact` (via `experimental.compaction.autocontinue`, requires the plugin's `client` capability). |
| `ocl-memory-shared.mjs` | Pure-logic module with no plugin hooks — path/config resolution (`getMemoryDir`, `getMemoryIndex`, `getDirtySentinel`), config parsing (`readMemoryRules`, `parseRules`, string-literal-aware `stripJsonc`), a filename safety check (`isSafeFilename`, rejects path separators and `..` segments in filenames read back from `MEMORY.md`), file I/O (`atomicWriteFileSync`, `ensureMemoryDir`), the cross-process lock (`acquireLock`/`releaseLock`), and the one-time `shared_dir` carry-over. Imported by both `ocl-memory.mjs` and `ocl-memory-tui.mjs` so both plugins resolve the exact same active directory. |
| `ocl-memory-tui.mjs` | TUI plugin — registered in `tui.jsonc`. Registers `ctrl+alt+m` keybinding. Provides an interactive, arrow-key-navigable browser over the memory index — view topic content, pin/unpin, and remove entries. All actions are direct file I/O; no LLM turn required. Resolves the active dir fresh on every open via `ocl-memory-shared.mjs`, so it follows `shared_dir` exactly like the server plugin; mutations are locked and written atomically, and the `.invalidate` sentinel is written at the active dir (local or shared). |
| `memory.md` (command) | `/memory` shows the index (retained - with LLM turn). `/memory <text>` stores a fact via `write_memory`. `/memory pin <topic>` pins via `pin_memory`. `/memory unpin <topic>` unpins. `/memory remove <topic>` removes via `remove_memory`. `/memory consolidate` reviews the session and writes undocumented facts. |
| `SKILL.md` | Loaded on-demand by the agent — full instructions for memory tools, format, index discipline, staleness handling, cap remediation, `shared_dir`, and consolidation. |

## Scope

**In scope:**

- Flat markdown persistence (`MEMORY.md` + topic files)
- System prompt injection on first turn, every `inject_every_n_turns` turns (default: 5), and immediately after any memory tool mutation
- Native plugin tools for write, remove, and pin operations
- TUI memory browser (`ctrl+alt+m`): interactive, arrow-key-navigable browser
- Automatic writes triggered by agent activity (issues solved, infra discovered, commands identified, hardware/model facts)
- Manual `/memory` command for show, explicit storage, pin, unpin, remove, and consolidate
- Auto-creation of `MEMORY.md` and `memory.jsonc` on first run; automatic migration from legacy `RULES.jsonc`
- Cap handling with truncation warning when index exceeds configured limit (default 300 lines) or 50 KB
- Configurable `max_lines`, `stale_after_days`, `shared_dir`, and `consolidate_on_compact` via `memory.jsonc`
- Index metadata: `[pin]` flag, `YYYY-MM-DDTHH:MM:SS±HH:MM` ISO datetime, `[stale?]` staleness flag per entry
- Index maintenance: orphan removal, duplicate removal, staleness flagging on tool calls
- Cross-tool shared memory store (`shared_dir`) with cross-process file lock and atomic writes, followed consistently by both the server plugin and the TUI browser
- Consolidation (`/memory consolidate`, `consolidate_on_compact`)

**Out of scope:**

- Semantic or fuzzy search across memories
- Custom MCP/remote/local server (the agent uses plugin-registered tools)
- Encryption
- Per-project memory (this is global, or shared cross-tool via `shared_dir` — never per-project)
- Real-time staleness monitoring (flags are stamped on tool calls, not on session load)
- Compaction handoff / mid-task state preservation across compaction

## System Compatibility

| Requirement | Notes                                                                                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| opencode    | >= 1.4.3                                                                                                                                                                                           |
| Node.js     | >= 18 (ESM,`fs`, `os`, `path` stdlib only)                                                                                                                                                         |
| Linux       | Full support                                                                                                                                                                                       |
| macOS       | Supported. opencode follows XDG on macOS, so`~/.config/opencode/` is used by default. If your opencode config lives elsewhere, set `XDG_CONFIG_HOME` to the parent of your `opencode/` config dir. |
| Windows     | Not supported                                                                                                                                                                                      |

## Token overhead

The plugin injects the `MEMORY.md` index and rendered `memory.jsonc` (behavioral rules only, as markdown) into the system prompt on the first turn of each session. Memory then persists in the system prompt automatically for the session — re-injection fires every `inject_every_n_turns` turns (default: 5) to pick up external edits, and immediately after any memory tool mutation to reflect the change just made. All other turns receive no injection. Cost scales with index size, but only pays on turns where injection actually occurs:


| State                                            | Est. tokens / injection |
| ------------------------------------------------ | ----------------------- |
| Fresh install (empty index, default memory.jsonc) | ~200                    |
| Typical use (10–30 entries, default memory.jsonc) | ~400–900               |
| Custom memory.jsonc (typical, 10–20 rules)        | similar to above        |
| At cap (configured limit, default 300 lines)     | ~6,500–7,400           |
| Hard cap (50 KB)                                 | ~12,800                  |

Estimates based on [Claude's tokenizer](https://www.claudetokenizer.com/) averaging 3.5–4 characters per token for markdown prose. Topic files are **not** injected — only the index line — so even a large memory store stays cheap until the index itself grows large. ISO 8601 datetimes in index lines add ~4 tokens/entry vs bare dates. Only the behavioral rule arrays are injected from `memory.jsonc`; scalar config keys (`max_lines`, `stale_after_days`, `inject_every_n_turns`, `shared_dir`, `consolidate_on_compact`) are plugin internals and do not appear in the system prompt.

## Disk I/O and injection overhead

Prior to v0.2.0, the plugin read `MEMORY.md` and `RULES.md` from disk on **every turn** and injected both into every system prompt. As of v0.3.0, `RULES.jsonc` replaces `RULES.md` and only the behavioral rule arrays are rendered and injected — scalar config keys are excluded from the system prompt. As of v0.5.0, `write_memory` accepts an optional `mode` parameter (`"append"` | `"replace"`) for overwriting stale content in place. As of v0.6.0, config relocated from `RULES.jsonc` to `memory.jsonc` (legacy installs auto-migrate), writes go through a temp-file-then-rename step for atomicity, an optional `shared_dir` setting redirects `MEMORY.md` and topic files to a cross-tool location guarded by a cross-process file lock, and path/config resolution logic was extracted into `ocl-memory-shared.mjs` so the TUI plugin follows `shared_dir` identically to the server plugin.

As of v0.2.0, two complementary optimizations apply (carried forward since):

**1. Disk reads** — both files are loaded once into an in-process cache on first use. The cache is invalidated only when a tool call mutates `MEMORY.md`. A forced fresh read is performed before compaction.

**2. Token injection** — `MEMORY.md` and `memory.jsonc` are injected into the system prompt on:
  - Turn 1 (session start)
  - Every `inject_every_n_turns` turns thereafter (default: 5 — so turns 1, 6, 11, 16...)
  - Any turn immediately following a memory tool mutation (`write_memory`, `remove_memory`, `pin_memory`)

All other turns receive no injection. Users can tune `inject_every_n_turns` in `memory.jsonc` — lower values (e.g. `2`) pick up external edits to `MEMORY.md` more quickly; higher values (e.g. `10`) reduce token overhead at the cost of slower refresh. In addition to this, the tool injects current `MEMORY.md` and rendered `memory.jsonc` content into the compaction context so memory survives context compression cleanly.

> **Note:** TUI memory browser actions (pin/unpin/remove via `ctrl+alt+m`) write `MEMORY.md` directly without going through the server plugin's `_cache`/`_dirty` state. Same caveat as manual file edits — changes are not reflected in the injected system prompt until the next tool call, the next periodic re-injection turn, or a compaction event (the `.invalidate` sentinel picks this up on the next `getCache()` call, at whichever dir — local or shared — is currently active). The TUI does resolve `shared_dir` correctly for where it reads/writes, via `ocl-memory-shared.mjs`; the caveat here is only about the server's injection cache timing, not path resolution.

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
| `/memory consolidate` | Reliable | Reliable | Usually works |
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
</content>
