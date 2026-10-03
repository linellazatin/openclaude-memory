# Configuration & Index Reference

[Back to README](../README.md)

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

Age maintenance runs on committed writes, removals, and pin changes, flagging entries older than `stale_after_days` (default: 180 days). Reads do not run maintenance. Repair is separately additive and marks recovered entries `[stale?]` for review regardless of their age. Metadata flags are recognized before ` -- `, not from summary text; pinning or disabling age flagging heals stale metadata during maintenance.

**Rules:**
- `[pin]` entries are never flagged, regardless of age.
- Entries with no date are never flagged.
- The flag self-heals: call `write_memory` on a stale topic and the date advances; the plugin removes `[stale?]` automatically on the next maintenance pass.

**What to do with `[stale?]` entries:**
- Ask the user if the topic is still relevant before acting.
- If yes: call `write_memory` to refresh it (flag disappears).
- If no: call `remove_memory` to remove the index entry (topic file preserved).

Set `"stale_after_days": 0` in `memory.jsonc` to disable age flagging entirely.

## Cap handling

`MEMORY.md` is capped at a configurable line limit (default **300 lines**) and an absolute **50 KB** hard limit. When either limit is exceeded, the plugin truncates the injected content at the configured limit and appends a warning comment to what the agent sees in its context:

```
<!-- memory truncated: MEMORY.md exceeds 300-line limit; shorten the index -->
```

The file on disk is untouched. The agent sees the warning and is responsible for trimming the index. The remediation procedure it follows (defined in `SKILL.md`):

1. Read `MEMORY.md` in full to assess all entries.
2. Identify entries that are candidates for removal:
   - **Skip**: any entry with `[pin]` — never a removal candidate.
   - **Maintenance**: committed updates drop missing/unsafe files and deduplicate by filename, choosing the newest full timestamp while preserving pins. Do not use `remove_memory` to discard one duplicate record: it removes all references to that topic file.
   - **`[stale?]` entries**: prioritised candidates — review these first.
   - **Remove only if clearly obsolete**: topic was session-specific and no longer applies; topic is fully superseded by a newer broader entry. When in doubt, keep the entry. Use `remove_memory`.
3. If all entries are still valid but the count is high, consolidate: merge two closely related topic files into one using `write_memory`, then `remove_memory` on the now-redundant entry.
4. Topic file content is never deleted — only index lines are removed.
5. Re-read `MEMORY.md` after trimming to confirm it is under the configured limit.

The cap exists to keep per-turn token overhead bounded. At the default 300 lines, the index alone costs ~6,500–7,400 tokens. A well-maintained index should stay well under 100 entries for typical personal use.

## memory.jsonc

`~/.config/opencode/memory.jsonc` is auto-created on first use without overwriting a racing creator's file. Edit it directly to configure persist rules and limits; changes, including edits to a symlink target, are detected at the next cache check. Config must resolve to a regular file; FIFO reads are refused without blocking. JSONC supports line comments, block comments, and trailing commas while preserving quoted URLs, globs, `,]`, and `,}` literally. Invalid scalar config is logged and falls back to defaults without rewriting the file; the rules renderer retains a raw-text fallback for malformed JSONC.

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
  // max_lines: valid range 50–1000
  "max_lines": 300,
  // stale_after_days: 0 = disable age flagging
  "stale_after_days": 180,
  // inject_every_n_turns: full disk refresh every N model requests; memory is always injected
  "inject_every_n_turns": 5,
  // shared_dir: true = store MEMORY.md and topic files at ~/.agents/memory/
  // so other tools can read/write the same files. This file always stays local.
  "shared_dir": false,
  // consolidate_on_compact: true = run a consolidation pass after automatic
  // compaction instead of opencode's default "continue" message.
  "consolidate_on_compact": false
}
```

Change `"max_lines"` to set a custom index size limit. The plugin clamps values to the valid range `[50, 1000]`. If the key is absent, the default of 300 is used.

Change `"stale_after_days"` to control when entries are flagged as stale. Set to `0` to disable age flagging entirely.

Change `inject_every_n_turns` to tune the forced disk-refresh interval in model requests, default `5`, minimum `1`. This process-wide counter includes model steps beyond user prompts. File-stamp changes, memory tools, and compaction refresh independently of this interval. The index and rules are attached to every request; increasing the interval does not save prompt tokens or disable injection.

Change `"shared_dir"` to `true` to move `MEMORY.md` and topic files to `~/.agents/memory/` — see [Cross-tool shared memory](shared-directory.md).

Change `"consolidate_on_compact"` to `true` to run consolidation automatically after automatic compaction — see [Consolidation](../README.md#consolidation) in the README.

The plugin renders non-empty behavioral rule arrays under `## Memory Rules` on every model request. Malformed JSONC or config with no non-empty behavioral arrays falls back to raw text, including scalar settings. `memory.jsonc` is the single source of truth for persist rules.

**Note:** Persist rules guide the model; they are not enforced permission checks or guarantees about what a model chooses to store.

**Migrating from pre-0.6.0 installs**: legacy `memory/RULES.jsonc` is copied into a missing `memory.jsonc` using exclusive publication. Only after success is the original renamed to `RULES.jsonc.bak`, and only if that backup does not exist. An existing config or backup is preserved; failed publication leaves the legacy original intact.
