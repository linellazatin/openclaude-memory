# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An opencode plugin (`@openlines/openclaude-memory`) that gives AI agents persistent markdown-based memory across sessions. Plain JavaScript ESM, no dependencies, no build step, no TypeScript.

## Commands

```sh
npm test                    # 120 sequential smoke checks plus real-process shared writers
node tests/smoke-test.mjs   # smoke checks only; no single-test filter
npm run test:host           # real OpenCode server plus local fake model
node tests/shared-store-test.mjs /absolute/path/to/openpi-memory/extensions/memory-core.mjs
for file in .opencode/plugins/*.mjs tests/*.mjs; do node --check "$file" || exit; done
```

No build, lint, or typecheck commands exist.

## Architecture

Three plugin files, all in `.opencode/plugins/`:

- **`ocl-memory.mjs`** — the main server-side plugin, registered in `opencode.json`. Exports a factory function (`export default async () => { return { config, tool, ... }; }`).
- **`ocl-memory-tui.mjs`** — interactive TUI browser (`ctrl+alt+m`), registered in `tui.jsonc`. Writes `MEMORY.md` directly through the same `withLock` (strict under `shared_dir`) atomic-write path as server tools and leaves an `.invalidate` sentinel; the server picks it up on its next cache check when both use the same active directory.
- **`ocl-memory-shared.mjs`**: path/config resolution, fail-closed locks in both modes, no-follow regular-file reads, flushed/cleaned atomic writes, metadata-flag parsing, and locked carry-over. Local acquisition waits about 500 ms; shared uses 2 s, a 1 s delay, and a second 2 s window. Config/file stamps refresh server caches; the TUI resolves config on open.

Module-level state (no reset API between tests):

- `ocl-memory.mjs`: `_cache` holds config, content, and file-stamp signature; `_requestCount` controls forced refresh frequency. Memory and rules are attached to every fresh model request, with no first-session gate.
- `ocl-memory-shared.mjs`: `_carryOverChecked` is set only after success/persisted sentinel; `_carryOverPending` coalesces concurrent attempts. Failed migration retries on a later refresh.

Memory is stored at `$XDG_CONFIG_HOME/opencode/memory/` (defaults to `~/.config/opencode/memory/`), or `~/.agents/memory/` if `"shared_dir": true`:
- `MEMORY.md` — index; one line per topic (ISO datetime timestamps throughout, not bare dates)
- `<slug>.md` — per-topic detail files

Config lives at local `~/.config/opencode/memory.jsonc`, with string-aware line/block comments and trailing commas. Legacy `memory/RULES.jsonc` is copied exclusively into a missing config before renaming the original to `.bak`; existing config/backups are preserved, and failed publication keeps the original intact.

Store reads use nonblocking, no-follow opens and verify regular descriptors; injection and previews are bounded before allocation. Trusted config symlinks are supported and target edits refresh cache stamps. Reserved `MEMORY.md`, unsafe filenames, directories, and symlink topic targets are refused. Removal records a tombstone before dropping all index references; reclaim requires matching frontmatter identity. TUI removal rechecks pins inside the lock and displays failures.

The plugin registers `config`, `tool`, `tool.execute.after`, `command.execute.before`, `experimental.chat.system.transform`, `experimental.session.compacting`, and `experimental.compaction.autocontinue`. Dynamic `/memory` paths refresh before execution. Automatic consolidation queues with `noReply: true` and preserves agent/model/variant; errors retain native continuation. Manual compaction and automatic user-message replay paths may bypass that hook.

### Injection behavior

`renderRulesForInjection` renders non-empty behavioral arrays (`always_persist`, `never_persist`, `always_ask`). Malformed JSONC or config with no non-empty behavioral arrays falls back to raw text, including scalar settings. Memory content is capped by both the configurable line limit (default 300) and a hard 50 KB byte cap; exceeding either truncates what the agent sees without modifying the file on disk.

### Tool arg schema invariant

Tool args use a **flat** `{ paramName: JSONSchema }` object. Do not wrap in a `{ type: 'object', properties: ... }` envelope — opencode's `legacyJsonSchema()` rejects the envelope and the arg-taking tools silently break (v0.5.1 hotfix). The plugin registers four tools: `write_memory`, `remove_memory`, `pin_memory`, and `repair_memory` (no args — additively re-indexes orphaned topic files).

### `write_memory` mode param

Both modes refresh current name/description/timestamp metadata, preserving creation and other fields. Append retains the body plus a dated section; replace overwrites it. Native flat-schema calls supply `pin` and `mode` explicitly. Ordinary failed publication attempts topic/index rollback; abrupt termination remains outside per-file atomicity. No directory-fsync or atomic lock compare-and-unlink guarantee is implied.

## Test quirks

`tests/smoke-test.mjs` sets `XDG_CONFIG_HOME` to a temp dir **before** importing the plugin — `MEMORY_DIR` is fixed at module load time and cannot be changed after import. Test order is load-bearing; there is no state reset API between tests. The comment "read the section comments before reordering" is accurate.

## Publishing

Push a `v*` tag (e.g. `v0.5.3`) → GitHub Actions publishes to npm via OIDC Trusted Publishing and auto-creates a release from `CHANGELOG.md`. `NODE_AUTH_TOKEN: ''` in `publish.yml` is intentional — do not replace it with a real token or OIDC breaks.

Current worktree version is 0.6.7. Update package version, skill frontmatter, and dated changelog together; publish CI verifies consistency before release. Documentation remains uncommitted by the user's current instruction, so do not tag a release until those versioned documents are included.

`.opencode/package.json` is gitignored and never published. Run `npm install` **inside `.opencode/`** (not root) to get type hints for `@opencode-ai/plugin`.

## Key files

| Path | Role |
|------|------|
| `.opencode/plugins/ocl-memory.mjs` | Server plugin (factory export) |
| `.opencode/plugins/ocl-memory-tui.mjs` | TUI browser (ctrl+alt+m) |
| `.opencode/plugins/ocl-memory-shared.mjs` | Shared path/config/lock logic, no plugin hooks |
| `tests/smoke-test.mjs` | 120 sequential, order-dependent checks |
| `tests/shared-store-test.mjs` | Real-process OpenCode/OpenCode or OpenCode/pi writers |
| `tests/host-test.mjs` | Real OpenCode 1.18.34 tool/injection/consolidation integration |
| `skills/memory/SKILL.md` | Agent skill loaded on-demand |
| `.opencode/command/memory.md` | Static `/memory` fallback resolves config and the active directory; dynamic registration wins at runtime and refreshes paths before execution |

See `AGENTS.md` for OIDC and dual command registration details.
