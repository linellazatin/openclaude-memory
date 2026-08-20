# Cross-tool shared memory (shared_dir)

[Back to README](../README.md)

## Overview

Set `"shared_dir": true` in `memory.jsonc` to move `MEMORY.md` and topic files to `~/.agents/memory/` — a location other memory-aware tools can also read and write, using the same on-disk format (e.g. [openpi-memory](https://github.com/linellazatin/openpi-memory), the pi.dev port of this project). `memory.jsonc` itself always stays local at `~/.config/opencode/memory.jsonc` regardless of this setting — only the index and topic files move.

The first time `shared_dir` resolves `true`, existing local memory is merged into the shared directory — copied, never moved. If the shared directory is empty, this is just a plain copy. If another tool (or a prior run of this same carry-over) already put content there, local entries are merged in alongside it: index lines are appended, and topic files are copied over unless a file with the same name and identical content already exists (then it's skipped — already synced) or a file with the same name but *different* content already exists (then the local copy is renamed with a `-oclm` suffix so nothing is overwritten or lost). This full merge scan runs at most once *ever* for a given local install: after it succeeds, a `.shared-dir-migrated` sentinel file is written into the local memory dir, so every later opencode session (a new process) short-circuits straight to a single file-existence check instead of re-scanning and re-comparing every entry. Because files are copied rather than moved, the originals remain in `~/.config/opencode/memory/` untouched — no separate backup dir is created. Toggling `shared_dir` off and back on does not re-run it or reconcile drift that happened while it was off — treat enabling it as a one-way move. See [Opting in when the shared dir already has content](#opting-in-when-the-shared-dir-already-has-content) below for a worked example.

Writes to the shared directory (and the local one) are protected by a cross-process advisory lock (`.lock` file, 10s stale-lock reclaim, 500ms acquire timeout) so this tool and another tool sharing the directory don't corrupt the index with interleaved writes. If the lock can't be acquired within the timeout, the write proceeds anyway rather than hanging — best-effort, not a hard guarantee.

Filenames read back from `MEMORY.md` (on remove, pin, and the carry-over merge itself) are validated against path traversal before use in any file operation — relevant specifically because `shared_dir` puts an untrusted co-tenant tool's writes into the same trust boundary as this plugin's own index file.

Path/config resolution (`getMemoryDir`, `getMemoryIndex`, `readMemoryRules`, the lock, and the carry-over itself) lives in a shared internal module (`ocl-memory-shared.mjs`) imported by both the server plugin and the TUI memory browser (`ctrl+alt+m`), so both always agree on which directory is active. The TUI re-reads `memory.jsonc` fresh every time you open the browser, so it picks up `shared_dir` immediately — no restart needed.

## First run: fresh install (shared_dir: false — the default)

On a brand-new install, nothing exists on disk yet. Here's exactly what happens, in order, on the first chat turn:

1. **`readMemoryRules()` runs.** Neither `~/.config/opencode/memory.jsonc` nor a legacy `~/.config/opencode/memory/RULES.jsonc` exists, so it writes fresh defaults to `~/.config/opencode/memory.jsonc`.
2. **`maybeCarryOverToSharedDir()` runs.** `shared_dir` defaults to `false` in fresh defaults, so this is a no-op.
3. **`getMemoryDir()` resolves** to the local path (`~/.config/opencode/memory/`, since `shared_dir` is `false`).
4. **`readMemoryIndex()` runs.** No `MEMORY.md` exists at that path yet, so it creates the directory and writes an empty index (`# Memory Index`).
5. **Injection happens.** The plugin pushes `## Global Memory` (empty index) and `## Memory Rules` (default rules) into the system prompt.

Resulting state:

```
~/.config/opencode/
├── memory.jsonc          # fresh defaults (shared_dir: false)
└── memory/
    └── MEMORY.md          # "# Memory Index" — empty, no entries yet
```

The agent's first turn sees the empty index and the default persist rules, ready to start calling `write_memory`.

## First run: fresh install, immediately opting into shared_dir: true

You're brand new to the plugin and want the shared store right away. Edit `memory.jsonc` to set `"shared_dir": true` — either after the first turn (when the plugin creates it), or bootstrap it manually before starting.

On the first cache load with `shared_dir: true`:

1. **`maybeCarryOverToSharedDir()` runs.** `_carryOverChecked` is `false` and `.shared-dir-migrated` doesn't exist — proceed to check for local content.
2. **No local `MEMORY.md` exists** (`~/.config/opencode/memory/MEMORY.md` was never created) → **carry-over is a no-op.** Sentinel is not written (nothing was merged).
3. **`getMemoryDir()` resolves** to `~/.agents/memory/`.
4. **`readMemoryIndex()` finds nothing there** — creates `~/.agents/memory/` and writes an empty index.

Resulting state:

```
~/.config/opencode/
├── memory.jsonc              # shared_dir: true
└── memory/                   # dir exists, no MEMORY.md — carry-over had nothing to do

~/.agents/memory/
└── MEMORY.md                 # empty — "# Memory Index"
```

From here, every `write_memory` call writes topic files and index entries directly to `~/.agents/memory/`. The local `~/.config/opencode/memory/` dir stays empty and inert. The sentinel is not written here (nothing was actually merged), so if you somehow later toggle `shared_dir: false`, create local memories, then toggle it back to `true`, the carry-over will pick up those local memories at that point.

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

**If you then opt into `shared_dir: true`** by editing `memory.jsonc`, the next cache load triggers a one-time carry-over: your `MEMORY.md` and topic files are copied into `~/.agents/memory/`. The originals stay fully intact — files are copied, not moved, so there's no need for a separate backup dir. A `.shared-dir-migrated` sentinel is written into the local memory dir after the merge completes, so every subsequent opencode session (a new process) short-circuits straight to a single existence check instead of re-scanning:

```
~/.config/opencode/
├── memory.jsonc
└── memory/                                # untouched, still fully intact
    ├── MEMORY.md
    ├── RULES.jsonc.bak
    ├── <topic>.md files...
    └── .shared-dir-migrated                # sentinel — carry-over done, never re-runs

~/.agents/memory/                          # NEW — active storage now
├── MEMORY.md
└── <topic>.md files...
```

See the [FAQ](faq.md) for common questions about toggling `shared_dir` and the pre-0.6.0 migration.

## Opting in when the shared dir already has content

Say you've been using the pi coding agent with [openpi-memory](https://github.com/linellazatin/openpi-memory), which already opted into its own `shared_dir` and wrote to `~/.agents/memory/`:

```
~/.agents/memory/
├── MEMORY.md              # openpi-memory's entries
├── docker-setup.md
└── homelab-notes.md
```

You now open opencode for the first time with real memories already sitting locally at `~/.config/opencode/memory/`, and you flip `"shared_dir": true` in `memory.jsonc`. Both projects use the exact same on-disk format (index line syntax, frontmatter, filename slugging), so the carry-over merges rather than skips:

1. **No collision** (e.g. your local `postgresql-setup.md`): copied straight into `~/.agents/memory/` under its original name, and its index line is appended to the shared `MEMORY.md`.
2. **Same filename, identical content** (rare, but possible if you'd previously used both tools against the same shared dir): skipped — it's already there, nothing to do.
3. **Same filename, different content** — say both tools happen to have a `docker-setup.md` about unrelated setups: your local `docker-setup.md` is copied in as `docker-setup-oclm.md`, and the index entry is added under that name, using your local topic's original title/summary/pin. openpi-memory's `docker-setup.md` is left completely untouched.

Resulting state — nothing from either tool is lost or overwritten:

```
~/.config/opencode/memory/                # untouched, still fully intact
├── MEMORY.md
├── docker-setup.md
├── postgresql-setup.md
├── .shared-dir-migrated                   # sentinel — carry-over done, never re-runs
└── ...

~/.agents/memory/                         # merged — both tools' entries coexist
├── MEMORY.md
├── docker-setup.md                        # openpi-memory's original, untouched
├── docker-setup-oclm.md                   # your local content, renamed to avoid the collision
├── homelab-notes.md                       # openpi-memory's, untouched
├── postgresql-setup.md                    # yours, no collision — copied as-is
└── ...
```

Every subsequent opencode session hits the `.shared-dir-migrated` sentinel on startup and returns immediately — no re-scan, no file reads, no index parsing. Because every write after the flip goes straight to the shared dir (nothing writes back to the local copy), a later session encountering the same already-merged state finds nothing new to do — it does not re-copy or grow additional `-oclm-2`, `-oclm-3` renames on repeat.

The reverse gap — openpi-memory itself skipping instead of merging when opencode already populated the shared dir first — is not fixed by this change; that would need an equivalent update on the openpi-memory side.
</content>
