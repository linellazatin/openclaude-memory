# openclaude-memory

[![npm version](https://img.shields.io/npm/v/@openlines/openclaude-memory)](https://www.npmjs.com/package/@openlines/openclaude-memory)
[![license](https://img.shields.io/npm/l/@openlines/openclaude-memory)](./LICENSE)

Global persistent memory for [opencode](https://opencode.ai) sessions. Inspired by Claude Code's auto-memory — your agent remembers what it learns, across every session, globally.

## Updates

- On-going work with 'localizing' logic from 'model-based' to 'plugin-based', getting closer towards my main goal (still learning the ropes on memory-handling); this should be a pretty 'major' release once done.
- On-going local LLM (very simple) test and benchmarks for instruction following - using my own 'mid-tier gaming' hardware (AMD, no ROCm, plain Vulkan by llama.cpp) - not really related with this project, but worth mentioning. Will be creating a separate 'doc' for those kinds of stuff.

> **A note on the current design**
>
> This plugin started as a personal project — a quick answer to a real need I had. Right now it leans heavily on the agent model to do the right thing: follow format rules, update dates, respect pins, and know when to write. That works well with strong models, and reasonably well with mid-range ones. It's an honest tradeoff I made to ship something useful fast.
>
> In future releases, I want to move more of that responsibility into the plugin itself — reducing how much you need to trust the model to get consistent behaviour, and bringing the design closer to the original philosophy of keeping things simple and deterministic. I don't have a timeline, but I'm genuinely committed to improving this. If you run into rough edges, feedback is welcome.

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

1. **Injection**: On every turn, the plugin reads `~/.config/opencode/memory/MEMORY.md` and injects its contents into the system prompt under a `## Global Memory` header.
2. **Topic files**: `MEMORY.md` is a concise index (one line per topic). Detail lives in separate topic files (`~/.config/opencode/memory/<topic>.md`), loaded on-demand by the agent when it needs more context.
3. **Native tools**: The plugin registers `write_memory`, `remove_memory`, and `pin_memory` tools. The agent calls these instead of raw file operations — the plugin guarantees consistent format, frontmatter, and index maintenance every time.
4. **Auto-writes**: The agent writes to memory automatically when it solves issues, discovers infrastructure, identifies reusable commands, or learns hardware/model facts — no prompting needed. Reliability varies by model; see [Model compatibility](#model-compatibility).
5. **Manual control**: Use `/memory` to view the current index, `/memory <text>` to store a fact immediately, `/memory pin <topic>` to pin an entry, `/memory unpin <topic>` to unpin, or `/memory remove <topic>` to remove one.
6. **Bootstrap**: On first run, the plugin creates `MEMORY.md` and `RULES.md` automatically. Nothing to set up.

## Native tools

The plugin registers three tools that the agent calls directly. These replace raw Write/Edit file operations for all memory writes.

| Tool | Args | What it does |
|---|---|---|
| `write_memory` | `topic`, `content`, `summary`, `pin?` | Creates a new topic file with YAML frontmatter, or appends to an existing one under a dated heading. Upserts the `MEMORY.md` index entry with today's date. |
| `remove_memory` | `topic` | Removes the index entry (case-insensitive match). Refuses if the entry is pinned. Topic file is preserved on disk. |
| `pin_memory` | `topic`, `pin` (bool) | Pins (`true`) or unpins (`false`) an index entry. Pinned entries are never flagged as stale and cannot be removed. |

After every tool call that touches `MEMORY.md`, the plugin runs an index maintenance pass: removes orphaned entries (file no longer on disk), removes duplicates (keeps the more recent), and stamps or removes `[stale?]` flags.

## Customising persist rules and config

`~/.config/opencode/memory/RULES.md` is auto-created on first run with sensible defaults. Edit it directly to add, remove, or modify rules, and to configure the index limits:

```markdown
# Memory Rules

## Always persist
- User preferences confirmed during session
- Project-specific conventions discovered

## Never persist
- Temporary workarounds
- Debug output and stack traces

## Always ask before persisting (non-overridable)
- Credentials, tokens, API keys
- Personal data

## Config
# max_lines: 200         (default; valid range 50–500)
# stale_after_days: 180  (default; 0 = disable age flagging)
```

Uncomment and change `max_lines` to set a custom index size limit. The plugin clamps values to the valid range `[50, 500]`. If the line is absent or commented, the default of 200 is used.

Uncomment and change `stale_after_days` to control when entries are flagged as stale. Set to `0` to disable age flagging entirely.

The plugin injects this file into every session's system prompt under a `## Memory Rules` header. RULES.md is the single source of truth for persist rules — no other configuration needed.

**Note:** The "Always ask before persisting" section is a strong convention. The agent will always prompt before storing credentials or personal data.

## Index metadata

Each entry in `MEMORY.md` can carry optional metadata fields:

```
- [Topic Name](file.md) [pin] YYYY-MM-DD [stale?] -- one-line summary
```

| Field | Meaning |
|---|---|
| `[pin]` | Permanent entry — never a cleanup candidate and never flagged as stale. Use for hardware specs, user identity, core workflows. |
| `YYYY-MM-DD` | Date the topic file was last written to. Maintained automatically by `write_memory`. |
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

Set `stale_after_days: 0` in `RULES.md` to disable age flagging entirely.

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
│   ├── plugins/ocl-memory.mjs          # plugin entry point — tools, system prompt injection
│   └── command/memory.md               # /memory slash command definition
└── skills/
    └── memory/SKILL.md                 # agent instructions for reading/writing memory
```

| File | Role |
|---|---|
| `ocl-memory.mjs` | Reads `MEMORY.md` on every turn, injects into system prompt. Registers `write_memory`, `remove_memory`, `pin_memory` tools. Runs index maintenance (orphan removal, duplicate removal, `[stale?]` stamping) after every tool call. Auto-creates files on first run. Caps injection at configured lines / 25 KB. |
| `memory.md` (command) | `/memory` shows the index. `/memory <text>` stores a fact via `write_memory`. `/memory pin <topic>` pins via `pin_memory`. `/memory unpin <topic>` unpins. `/memory remove <topic>` removes via `remove_memory`. |
| `SKILL.md` | Loaded on-demand by the agent — full instructions for memory tools, format, index discipline, staleness handling, and cap remediation. |

## Scope

**In scope:**

- Flat markdown persistence (`MEMORY.md` + topic files)
- System prompt injection every session turn
- Native plugin tools for write, remove, and pin operations
- Automatic writes triggered by agent activity (issues solved, infra discovered, commands identified, hardware/model facts)
- Manual `/memory` command for show, explicit storage, pin, unpin, and remove
- Auto-creation of `MEMORY.md` and `RULES.md` on first run
- Cap handling with truncation warning when index exceeds configured limit (default 200 lines) or 25 KB
- Configurable `max_lines` and `stale_after_days` via `## Config` section in `RULES.md`
- Index metadata: `[pin]` flag, `YYYY-MM-DD` date, `[stale?]` staleness flag per entry
- Index maintenance: orphan removal, duplicate removal, staleness flagging on tool calls

**Out of scope:**

- Semantic or fuzzy search across memories
- Custom MCP server (the agent uses plugin-registered tools)
- Encryption or sync
- Per-project memory (this is global only)
- Real-time staleness monitoring (flags are stamped on tool calls, not on session load)

## Installation and Update

### Install

Add to your `~/.config/opencode/opencode.json` (or `opencode.jsonc`) `plugin` array:

```json
{
  "plugin": [
    "@openlines/openclaude-memory"
  ]
}
```

Restart opencode. On the first chat turn of the next session, `~/.config/opencode/memory/MEMORY.md` and `RULES.md` will be created automatically, and both `## Global Memory` and `## Memory Rules` blocks will appear in the agent's context. No manual configuration required.

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

The plugin injects the `MEMORY.md` index into the system prompt on every turn. Cost scales with index size:


| State                                          | Est. tokens / turn |
| ------------------------------------------------ | -------------------- |
| Fresh install (empty index, default RULES.md)  | ~120               |
| Typical use (10–30 entries, default RULES.md) | ~300–700          |
| Custom RULES.md (typical, 10–20 lines)        | similar to above   |
| At cap (configured limit, default 200 lines)   | ~4,300–4,900      |
| Hard cap (25 KB)                               | ~6,400             |

Estimates based on [Claude's tokenizer](https://www.claudetokenizer.com/) averaging 3.5–4 characters per token for markdown prose. Topic files are **not** injected — only the index line — so even a large memory store stays cheap until the index itself grows large.

For reference, Claude Sonnet's context window is ~200K tokens. Worst-case overhead from this plugin is ~3% of that.

## Model compatibility

The plugin injects plain markdown into the system prompt and registers structured tools — no model-specific features required. Tool calls are more reliable than free-form write instructions, especially on smaller models.

Modern instruction-tuned models — including compact ones in the 4–9B range — handle all core features well. The table below reflects 2026-era model quality; results from older or poorly instruction-tuned models may vary.

Where a feature is backed by a plugin tool, the tool guarantees correct format and index integrity regardless of model tier — only the model's decision to call the tool (and what args to pass) varies.

| Feature | Upper mid to large (14B+) | Mid-range (7–13B, well instruction-tuned) | Compact (<7B, modern) |
|---|---|---|---|
| `/memory` show index | Reliable | Reliable | Reliable |
| `/memory <text>` store via `write_memory` | Reliable | Reliable | Reliable |
| `/memory pin/unpin <topic>` via `pin_memory` | Reliable | Reliable | Reliable |
| `/memory remove <topic>` via `remove_memory` | Reliable | Reliable | Reliable |
| Auto-trigger writes (persist rules) | Reliable | Usually works | Best-effort |
| Topic/summary quality on auto-writes | Reliable | Usually works | Best-effort |
| Date stamping on auto-writes | Plugin-guaranteed | Plugin-guaranteed | Plugin-guaranteed |
| `[pin]` on auto-writes (arg passed correctly) | Reliable | Usually works | Best-effort; verify with `/memory` after |
| `[stale?]` flagging and self-healing | Plugin-guaranteed | Plugin-guaranteed | Plugin-guaranteed |

**Mitigations already in place:**
- Structured tool calls replace free-form write instructions — format, frontmatter, and index integrity are guaranteed by the plugin
- Date stamping is handled by the plugin, not the model — no model tier can get it wrong
- `[stale?]` flagging and orphan/duplicate cleanup run entirely in the plugin
- `/memory pin`, `/memory unpin`, and `/memory remove` are single structured tool calls — reliable even on compact models

If you are using an older or lightly instruction-tuned model, `/memory <text>` explicit commands will always be more reliable than auto-trigger writes.

## License

MIT
