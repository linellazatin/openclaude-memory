# Cross-tool shared memory (shared_dir)

[Back to README](../README.md)

## Overview

Set `"shared_dir": true` in `memory.jsonc` to move `MEMORY.md` and topic files to `~/.agents/memory/` — a location other memory-aware tools can also read and write, using the same on-disk format (e.g. [openpi-memory](https://github.com/linellazatin/openpi-memory), the pi.dev port of this project). `memory.jsonc` itself always stays local at `~/.config/opencode/memory.jsonc` regardless of this setting — only the index and topic files move.

The first time `shared_dir` resolves `true`, existing local memory is copied — never moved — into the shared directory. This carry-over runs once per process (guarded by an in-process flag), and only if the shared directory doesn't already have a `MEMORY.md`. Because files are copied rather than moved, the originals remain in `~/.config/opencode/memory/` untouched — no separate backup dir is created. Toggling `shared_dir` off and back on does not re-run it or reconcile drift that happened while it was off — treat enabling it as a one-way move.

Writes to the shared directory (and the local one) are protected by a cross-process advisory lock (`.lock` file, 10s stale-lock reclaim, 500ms acquire timeout) so this tool and another tool sharing the directory don't corrupt the index with interleaved writes. If the lock can't be acquired within the timeout, the write proceeds anyway rather than hanging — best-effort, not a hard guarantee.

Path/config resolution (`getMemoryDir`, `getMemoryIndex`, `readMemoryRules`, the lock, and the carry-over itself) lives in a shared internal module (`ocl-memory-shared.mjs`) imported by both the server plugin and the TUI memory browser (`ctrl+alt+m`), so both always agree on which directory is active. The TUI re-reads `memory.jsonc` fresh every time you open the browser, so it picks up `shared_dir` immediately — no restart needed.

## First run: fresh install

On a brand-new install, nothing exists on disk yet. Here's exactly what happens, in order, on the first chat turn (when `experimental.chat.system.transform` first fires):

1. **`readMemoryRules()` runs.** Neither `~/.config/opencode/memory.jsonc` nor a legacy `~/.config/opencode/memory/RULES.jsonc` exists, so it writes fresh defaults to `~/.config/opencode/memory.jsonc`.
2. **`maybeCarryOverToSharedDir()` runs.** `shared_dir` defaults to `false` in fresh defaults, so this is a no-op.
3. **`getMemoryDir()` resolves** to the local path (`~/.config/opencode/memory/`, since `shared_dir` is `false`).
4. **`readMemoryIndex()` runs.** No `MEMORY.md` exists at that path yet, so it creates the directory and writes an empty index (`# Memory Index`).
5. **Injection happens.** The plugin pushes `## Global Memory` (empty index) and `## Memory Rules` (default rules) into the system prompt.

Resulting state:

```
~/.config/opencode/
├── memory.jsonc          # fresh defaults
└── memory/
    └── MEMORY.md          # "# Memory Index" — empty, no entries yet
```

The agent's first turn sees the empty index and the default persist rules, ready to start calling `write_memory`.

## First run: upgrading from a pre-0.6.0 install

If you already have memories and a config from before 0.6.0, nothing you have is touched destructively — the upgrade only adds files.

Starting state:

```
~/.config/opencode/memory/
├── MEMORY.md              # your real entries
├── RULES.jsonc             # your custom config
└── <topic>.md files...
```

1. **`readMemoryRules()` runs.** It finds no `~/.config/opencode/memory.jsonc`, but finds your legacy `~/.config/opencode/memory/RULES.jsonc`. It renames that file to `RULES.jsonc.bak` (one-time — the rename itself means this branch is never hit again on subsequent turns) and copies its content forward into the new `memory.jsonc`. Your original config content is preserved, just relocated to a `.bak` suffix — never deleted.
2. **`getMemoryDir()` resolves** to the local path — still `~/.config/opencode/memory/`, since `shared_dir` isn't in your old config and defaults to `false`.
3. **`readMemoryIndex()` finds your real `MEMORY.md` already there** and reads it back untouched.
4. **Your first turn after upgrading.** Injection works exactly as before: your real index and your custom rules are injected, unchanged.

Resulting state — one file renamed (to `.bak`, content preserved), one new file added, nothing removed:

```
~/.config/opencode/
├── memory.jsonc            # NEW — copy of your old config
└── memory/
    ├── MEMORY.md            # unchanged
    ├── RULES.jsonc.bak      # RENAMED from RULES.jsonc — content preserved
    └── <topic>.md files...   # unchanged
```

Net effect: the agent's first turn after upgrading behaves exactly as it did before. Your memory content and rules are preserved as-is.

**If you then opt into `shared_dir: true`** by editing `memory.jsonc`, the next cache load triggers a one-time carry-over: `MEMORY.md` and your topic files are copied into `~/.agents/memory/`. Your original `~/.config/opencode/memory/` directory is left fully intact — files are copied, not moved, so there's no need for a separate backup dir:

```
~/.config/opencode/
├── memory.jsonc
└── memory/                                # untouched, still fully intact
    ├── MEMORY.md
    ├── RULES.jsonc.bak
    └── <topic>.md files...

~/.agents/memory/                          # NEW — active storage now
├── MEMORY.md
└── <topic>.md files...
```

See the [FAQ](faq.md) for common questions about toggling `shared_dir` and the pre-0.6.0 migration.
</content>
