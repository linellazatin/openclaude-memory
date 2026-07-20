# openclaude-memory

[![npm version](https://img.shields.io/npm/v/@openlines/openclaude-memory)](https://www.npmjs.com/package/@openlines/openclaude-memory)
[![license](https://img.shields.io/npm/l/@openlines/openclaude-memory)](./LICENSE)

Global persistent memory for [opencode](https://opencode.ai) sessions. Inspired by Claude Code's auto-memory — your agent remembers what it learns, across every session, globally.

## Why

I built this because I genuinely like how Claude Code handles memory: no complex algorithms, no external LLM for heavy lifting, no vector databases. It just works — the agent reads a markdown file and acts on it. Simple, transparent, effective.

I also wanted something local-first. My memories and notes stay on my machine, in plain markdown files I can read, edit, and audit at any time. No cloud sync, no embeddings pipeline, no black-box retrieval. If I want to know what the agent remembers, I open a file.

When something worth remembering happens (a bug fixed, a config discovered, a command identified), the agent writes it to a structured markdown memory store. The next session, that context is already there — injected automatically into the system prompt before the first message.

## How it works

1. **Injection**: On every turn, the plugin reads `~/.config/opencode/memory/MEMORY.md` and injects its contents into the system prompt under a `## Global Memory` header.
2. **Topic files**: `MEMORY.md` is a concise index (one line per topic). Detail lives in separate topic files (`~/.config/opencode/memory/<topic>.md`), loaded on-demand by the agent when it needs more context.
3. **Auto-writes**: The agent writes to memory automatically when it solves issues, discovers infrastructure, identifies reusable commands, or learns hardware/model facts — no prompting needed.
4. **Manual control**: Use `/memory` to view the current index, or `/memory <text>` to store a fact immediately.
5. **Bootstrap**: On first run, the plugin creates `MEMORY.md` automatically. Nothing to set up.

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

Restart opencode. On the next session, `~/.config/opencode/memory/MEMORY.md` will be created automatically if it doesn't exist, and the `## Global Memory` block will appear in the agent's context.

## Compatibility

| Requirement | Version |
|---|---|
| opencode | >= 1.4.3 (`@opencode-ai/plugin`) |
| Node.js | >= 18 (ESM, `fs`, `os`, `path` stdlib only) |
| Platform | Linux, macOS |

## License

MIT
