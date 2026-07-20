# openclaude-memory

[![npm version](https://img.shields.io/npm/v/@openlines/openclaude-memory)](https://www.npmjs.com/package/@openlines/openclaude-memory)
[![license](https://img.shields.io/npm/l/@openlines/openclaude-memory)](./LICENSE)

Global persistent memory for [opencode](https://opencode.ai) sessions. Inspired by Claude Code's auto-memory — your agent remembers what it learns, across every session, globally.

## Why

I built this because I genuinely like how Claude Code handles memory: no complex algorithms, no external LLM for heavy lifting, no vector databases. It just works — the agent reads a markdown file and acts on it. Simple, transparent, effective.

I also wanted something local-first. My memories and notes stay on my machine, in plain markdown files I can read, edit, and audit at any time. No cloud sync, no embeddings pipeline, no black-box retrieval. If I want to know what the agent remembers, I open a file.

When something worth remembering happens (a bug fixed, a config discovered, a command identified), the agent writes it to a structured markdown memory store. The next session, that context is already there — injected automatically into the system prompt before the first message.

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
3. **Auto-writes**: The agent writes to memory automatically when it solves issues, discovers infrastructure, identifies reusable commands, or learns hardware/model facts — no prompting needed.
4. **Manual control**: Use `/memory` to view the current index, or `/memory <text>` to store a fact immediately.
5. **Bootstrap**: On first run, the plugin creates `MEMORY.md` and `RULES.md` automatically. Nothing to set up.

## Customising persist rules

`~/.config/opencode/memory/RULES.md` is auto-created on first run with sensible defaults. Edit it directly to add, remove, or modify rules:

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
```

The plugin injects this file into every session's system prompt under a `## Memory Rules` header. RULES.md is the single source of truth for persist rules — no other configuration needed.

**Note:** The "Always ask before persisting" section is a strong convention. The agent will always prompt before storing credentials or personal data.

## Cap handling

`MEMORY.md` is capped at **200 lines or 25 KB**. The plugin never modifies `MEMORY.md` — it is read-only at the plugin level. When either limit is exceeded, the plugin truncates the injected content at 200 lines and appends a warning comment to what the agent sees in its context:

```
<!-- memory truncated: MEMORY.md exceeds 200-line limit; shorten the index -->
```

The file on disk is untouched. The agent sees the warning and is responsible for trimming the index. The remediation procedure it follows (defined in `SKILL.md`):

1. Read `MEMORY.md` in full to assess all entries.
2. Remove index lines that are stale (topic no longer relevant), superseded (merged into another topic file), or duplicated.
3. If all entries are still valid but the count is high, consolidate: merge two closely related topic files into one and update the index entry to reflect the combined scope.
4. Topic file content is never deleted — only index lines are removed.
5. Re-read `MEMORY.md` after trimming to confirm it is under 200 lines.

The cap exists to keep per-turn token overhead bounded. At 200 lines, the index alone costs ~4,300–4,900 tokens. A well-maintained index should stay well under 100 entries for typical personal use.

## Plugin architecture

```
openclaude-memory/
├── package.json                        # npm package manifest
├── .opencode/
│   ├── plugins/ocl-memory.mjs          # plugin entry point — system prompt injection
│   └── command/memory.md               # /memory slash command definition
└── skills/
    └── memory/SKILL.md                 # agent instructions for reading/writing memory
```

| File | Role |
|---|---|
| `ocl-memory.mjs` | Reads `MEMORY.md` on every turn, injects into system prompt. Auto-creates the file on first run. Caps injection at 200 lines / 25 KB. |
| `memory.md` (command) | `/memory` with no args shows the index. `/memory <text>` stores a fact immediately. |
| `SKILL.md` | Loaded on-demand by the agent — full instructions for the memory format, write procedures, index discipline, and cap remediation. |

## Scope

**In scope:**
- Flat markdown persistence (`MEMORY.md` + topic files)
- System prompt injection every session turn
- Automatic writes triggered by agent activity (issues solved, infra discovered, commands identified, hardware/model facts)
- Manual `/memory` command for explicit storage and viewing
- Auto-creation of `MEMORY.md` on first run
- Cap handling with truncation warning when index exceeds 200 lines / 25 KB

**Out of scope:**
- Semantic or fuzzy search across memories
- Custom MCP server (the agent uses standard Read/Write/Edit tools)
- Encryption or sync
- Per-project memory (this is global only)

## Installation

Add to your `~/.config/opencode/opencode.json` (or `opencode.jsonc`) `plugin` array:

```json
{
  "plugin": [
    "@openlines/openclaude-memory"
  ]
}
```

Restart opencode. On the next session, `~/.config/opencode/memory/MEMORY.md` and `RULES.md` will be created automatically, and both `## Global Memory` and `## Memory Rules` blocks will appear in the agent's context. No manual configuration required.

## Compatibility

| Requirement | Notes |
|---|---|
| opencode | >= 1.4.3 |
| Node.js | >= 18 (ESM, `fs`, `os`, `path` stdlib only) |
| Linux | Full support |
| macOS | Supported. opencode follows XDG on macOS, so `~/.config/opencode/` is used by default. If your opencode config lives elsewhere, set `XDG_CONFIG_HOME` to the parent of your `opencode/` config dir. |
| Windows | Not supported |

## Token overhead

The plugin injects the `MEMORY.md` index into the system prompt on every turn. Cost scales with index size:

| State | Est. tokens / turn |
|---|---|
| Fresh install (empty index, default RULES.md) | ~120 |
| Typical use (10–30 entries, default RULES.md) | ~300–700 |
| Custom RULES.md (typical, 10–20 lines) | similar to above |
| At cap (200 lines index) | ~4,300–4,900 |
| Hard cap (25 KB) | ~6,400 |

Estimates based on Claude's tokenizer averaging 3.5–4 characters per token for markdown prose. Topic files are **not** injected — only the index line — so even a large memory store stays cheap until the index itself grows large.

For reference, Claude Sonnet's context window is ~200K tokens. Worst-case overhead from this plugin is ~3% of that.

## License

MIT
