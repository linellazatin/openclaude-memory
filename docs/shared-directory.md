# Cross-tool shared memory (shared_dir)

[Back to README](../README.md)

## Overview

Set `"shared_dir": true` in `memory.jsonc` to move `MEMORY.md` and topic files to `~/.agents/memory/` — a location other memory-aware tools can also read and write, using the same on-disk format (e.g. [openpi-memory](https://github.com/linellazatin/openpi-memory), the pi.dev port of this project). `memory.jsonc` itself always stays local at `~/.config/opencode/memory.jsonc` regardless of this setting — only the index and topic files move. Note that co-tenancy requires the flag on **both sides**: openpi-memory keeps its own config at `~/.pi/agent/memory.jsonc` with its own independent `shared_dir` setting. If only one tool enables it, both run fine but write to different directories — the shared store silently has a single tenant.

The first time `shared_dir` resolves `true`, existing local memory is merged into the shared directory — copied, never moved. If the shared directory is empty, this is just a plain copy. If another tool (or a prior run of this same carry-over) already put content there, local entries are merged in alongside it: index lines are appended, and topic files are copied over unless a file with the same name and identical content already exists (then it's skipped — already synced) or a file with the same name but *different* content already exists (then the local copy is renamed with a `-oclm` suffix so nothing is overwritten or lost). This full merge scan runs at most once *ever* for a given local install: after it **succeeds**, a `.shared-dir-migrated` sentinel file is written into the local memory dir, so every later resolution (a new process, or a cache refresh in this one) short-circuits straight to a single file-existence check instead of re-scanning and re-comparing every entry. A failed or lock-contended attempt writes no sentinel and is retried on the next cache refresh within the same process, not just the next session. Because files are copied rather than moved, the originals remain in `~/.config/opencode/memory/` untouched — no separate backup dir is created. Toggling `shared_dir` off and back on does not re-run it or reconcile drift that happened while it was off — treat enabling it as a one-way move. See [Opting in when the shared dir already has content](#opting-in-when-the-shared-dir-already-has-content) below for a worked example.

Writes are serialized by the active directory's advisory `.lock`, carrying a compatible `pid\ttimestamp\ttoken`. Reclaim checks age, holder liveness (`EPERM` means alive), and unchanged inode/mtime; unknown payloads are eligible only after 60 seconds. Each `withLock` call captures its own token before awaiting and checks that token on release. Failed stale-lock deletion obeys the acquisition deadline rather than looping indefinitely. These checks narrow replacement races; there is no atomic compare-and-unlink primitive in this protocol. Contention behavior depends on the mode:

- **Shared (`shared_dir: true`)** — writes **fail closed**: the tool waits up to ~2s, then sleeps and auto-retries once (another ~2s), and only if the lock is still held does it return `"memory store is busy … retry in a moment"` rather than writing. This guarantees an in-flight write by a co-tenant tool (e.g. openpi-memory, which holds the same `.lock`) is never clobbered by an unlocked write. The retry is automatic, so transient contention is invisible in practice.
- **Local (`shared_dir: false`)**: waits about 500 ms, then refuses with a busy message. Multiple local sessions are writers too; no mutation proceeds unlocked.

Read-back filenames must be safe non-hidden `.md` basenames, excluding `MEMORY.md`, separators, control characters, `..`, and link-breaking characters. Reads verify a no-follow file descriptor; directories and symlinks are not topic files. Atomic copies and writes flush file contents and clean temporary files. An identical shared topic still gains a missing index line. A tombstoned slug is reclaimed only for the same frontmatter topic, not an unrelated colliding name.

Carry-over holds the local lock before the shared lock and skips the union of both tombstone lists. Each file is atomic, not the entire multi-file operation: normal write failures attempt rollback, but abrupt termination can leave unindexed copies or stale index metadata. Repair recovers missing entries; see [recovery boundaries](architecture.md#recovery-boundaries). Both harnesses need the coordinated locking implementation; older pi startup cleanup or missing-index bootstrap can write without the lock.

## Recovering orphaned topics (`/memory repair`)

Discovery in openclaude-memory is index-driven: the agent only sees topics listed in `MEMORY.md`. A co-tenant tool can legitimately write topic `.md` files into the shared dir (or rewrite the shared `MEMORY.md` from its own smaller view) and leave openclaude's topic files present on disk but absent from the index — silently undiscoverable.

`/memory repair` (tool: `repair_memory`) scans the active memory dir for topic `.md` files missing from `MEMORY.md` and appends an index line for each, marked `[stale?]` and dated from the file's own frontmatter (`last_updated` → `created`; all recovered fields are sanitized so a corrupted co-tenant timestamp can't forge flags on the emitted line). It is **additive only** — it never deletes, reorders, or overwrites existing entries, skips `MEMORY.md`/unsafe filenames, skips any filename tombstoned by `remove_memory` (recorded in `.ocl-removed` — the same filename openpi-memory uses, so under `shared_dir` either tool's removals are honored by both — and a deliberate removal is never resurrected), and is idempotent (a second run adds nothing). When `shared_dir` is active and the on-disk topic-file count (excluding tombstoned files) exceeds the indexed count by more than 5, the injected `## Global Memory` block gains a non-mutating maintenance note prompting you to run `/memory repair`. Repair is never run automatically — a co-tenant may be mid-write — so it is always an explicit, user-initiated action.

Note on collision suffixes: openclaude renames colliding carry-over files with `-oclm`; openpi-memory uses `-opim`. This divergence is intentional so each tool's collision copies are self-attributed and the two never overwrite each other's files.

Both plugins share path/config and mutation helpers. The TUI re-reads config on every open; server cache checks detect config/index/tombstone/sentinel/directory changes before reuse. Sentinels are observed without deletion, so every server process can refresh. Dynamic `/memory` also updates its paths before execution. Switching paths does not re-run a successful migration.

## First run: fresh install (shared_dir: false — the default)

On a brand-new install, nothing exists on disk yet. Here's exactly what happens, in order, on the first chat turn:

1. **`readMemoryRules()` runs.** Neither `~/.config/opencode/memory.jsonc` nor a legacy `~/.config/opencode/memory/RULES.jsonc` exists, so it writes fresh defaults to `~/.config/opencode/memory.jsonc`.
2. **`maybeCarryOverToSharedDir()` runs.** `shared_dir` defaults to `false` in fresh defaults, so this is a no-op.
3. **`getMemoryDir()` resolves** to the local path (`~/.config/opencode/memory/`, since `shared_dir` is `false`).
4. **`readMemoryIndex()` runs.** No `MEMORY.md` exists at that path yet, so it returns the empty index (`# Memory Index`) **in-memory** — it does **not** create the file or the directory on this read path (the file is created only by the first locked `write_memory` or by carry-over).
5. **Injection happens.** The plugin pushes `## Global Memory` (empty index) and `## Memory Rules` (default rules) into the system prompt.

Resulting state (nothing written to `memory/` yet — it materializes on the first `write_memory`):

```
~/.config/opencode/
├── memory.jsonc          # fresh defaults (shared_dir: false)
└── memory/               # created on the first write_memory (with MEMORY.md + topic files)
```

The agent's first turn sees the empty index and the default persist rules, ready to start calling `write_memory`.

## First run: fresh install, immediately opting into shared_dir: true

You're brand new to the plugin and want the shared store right away. Edit `memory.jsonc` to set `"shared_dir": true` — either after the first turn (when the plugin creates it), or bootstrap it manually before starting.

On the first cache load with `shared_dir: true`:

1. **`maybeCarryOverToSharedDir()` runs.** `_carryOverChecked` is `false` and `.shared-dir-migrated` doesn't exist — proceed to check for local content.
2. **No local `MEMORY.md` exists** (`~/.config/opencode/memory/MEMORY.md` was never created) → **carry-over is a no-op.** Sentinel is not written (nothing was merged).
3. **`getMemoryDir()` resolves** to `~/.agents/memory/`.
4. **`readMemoryIndex()` finds nothing there** — returns an empty index in-memory without creating the file. `~/.agents/memory/MEMORY.md` is created by the first locked `write_memory`.

Resulting state:

```
~/.config/opencode/
├── memory.jsonc              # shared_dir: true
└── memory/                   # not created — no local write happened, carry-over had nothing to do

~/.agents/memory/             # created on the first write_memory (with MEMORY.md + topic files)
```

From here, every `write_memory` call writes topic files and index entries directly to `~/.agents/memory/`. The local `~/.config/opencode/memory/` dir stays absent/inert. The sentinel is not written here (nothing was actually merged), so if you somehow later toggle `shared_dir: false`, create local memories, then toggle it back to `true`, the carry-over will pick up those local memories at that point.

## First run: upgrading from a pre-0.6.0 install

If you already have memories and a config from before 0.6.0, nothing you have is touched destructively — the upgrade only adds files.

Starting state:

```
~/.config/opencode/memory/
├── MEMORY.md              # your real entries
├── RULES.jsonc             # your custom config
└── <topic>.md files...
```

1. **`readMemoryRules()` runs.** It finds a missing `memory.jsonc` and an existing legacy `memory/RULES.jsonc`. It publishes a complete copy exclusively, preserving a racing creator's config. Only after successful publication does it rename the legacy original to `.bak`, and only if that backup does not already exist. Publication failure leaves the original intact; an existing config or backup is never replaced.
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

After successful migration, the sentinel skips the carry-over scan in subsequent sessions. Normal config and active-index reads still occur. While shared mode remains enabled, writes go directly to the shared store; migration does not re-copy local files or create additional collision suffixes on each session.

The coordinated sibling implementation also merges into an existing shared index, locks its recap retirement, leaves missing-index reads read-only, and uses captured directory/lock ownership for mutations. Verify interoperability with `node tests/shared-store-test.mjs /absolute/path/to/openpi-memory/extensions/memory-core.mjs`; it runs both harnesses in separate real processes against temporary shared storage and checks topic bodies, pins, removals, foreign entries, and cleanup.
