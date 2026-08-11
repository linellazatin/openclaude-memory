# Changelog

All notable changes to this project will be documented in this file.

## [0.5.0] - 2026-08-12

### Added — TUI memory browser

- `ocl-memory-tui.mjs`: new TUI plugin (plain ESM, no build step) for memory index management. Register to `tui.jsonc` - see [README](README.md).
- `ctrl+alt+m` keybinding, arrow-key-navigable list of all memory index entries — all actions are direct file I/O — no round-trip to the server plugin or the LLM.

### Updated — core plugin (ocl-memory.mjs)

- `mode` parameter on `write_memory` (`"append"` | `"replace"`, default `"append"`). `"replace"` overwrites the topic body while preserving frontmatter and advancing `last_updated` — no dated heading is appended. Mirrors Claude Code's "rewrite stale content" principle. Backwards compatible: existing callers without `mode` get the previous append behavior.
- 1 new smoke test for `mode: replace` (23 tests total, was 22).

### Updated — core SKILL

- **Memory Types** section: 4-type taxonomy (`user`, `feedback`, `project`, `reference`) with per-type guidance on when to save, when to recall, and what body structure to use. `feedback` and `project` types get a `Rule → **Why:** → **How to apply:**` scaffold.
- **When to save** section: proactive saving triggers, and a principle-based "do not save" list (code derivable from codebase, git history, debugging recipes, ephemeral state, things in AGENTS.md/CLAUDE.md).
- **Freshness verification** section: before acting on any file path, function name, or flag named in a memory, grep/read to confirm it still exists.
- **Cross-linking** convention: use `[[slug]]` in topic file bodies to reference related memories.
- `description` field re-stated as a relevance/gateway trigger, not a summary.
- `mode` parameter documented in the "Updating an existing topic" section.

### Changed

- `INITIAL_RULES_JSONC` `never_persist` defaults rewritten from generic examples to principle-based exclusions: `code patterns derivable from the codebase, git history, debugging fix recipes, ephemeral task state, things already in AGENTS.md/CLAUDE.md, large code blocks`. Existing users' `~/.config/opencode/memory/RULES.jsonc` on disk is unaffected — only fresh installs (or users who delete their `RULES.jsonc`) receive the new defaults, so feel free to add these into your already existing config.

### Notes

- The methodology additions to `SKILL.md` (types, proactive saving, structured body) are all stemmed from how Claude Code does its memory. Inspired by how Claude Code's internal memory system structures memories by type, captures both corrections and confirmations, and guides agents to reason about edge cases rather than just recite facts - thus OPENCLAUDE lol.
- Known: `api.ui.DialogSelect` etc. are called as plain functions (not via JSX/`createComponent`). Behaviour depends on opencode's TUI reactive context wrapping `dialog.replace`. Verified only on first live run.

## [0.3.0] - 2026-08-10

### Added

- `RULES.jsonc` replaces `RULES.md` as the configuration file. Structured JSONC with `//` comment support; `parseRules()` replaces `parseConfig()` using regex-strip + `JSON.parse` (no library). Supports the same three config keys (`max_lines`, `stale_after_days`, `inject_every_n_turns`) plus three new structured array keys: `always_persist`, `never_persist`, `always_ask`.
- Auto-migration on plugin load: if `RULES.jsonc` is absent but `RULES.md` exists, the plugin migrates the markdown sections and any uncommented config values into a new `RULES.jsonc` and renames the old file to `RULES.md.bak`. Existing installs upgrade transparently on the first session after updating.
- `renderRulesForInjection()`: transforms `RULES.jsonc` content into clean markdown before injecting into the system prompt. Only the behavioral array keys (`always_persist`, `never_persist`, `always_ask`) are rendered as markdown bullet lists. Scalar config keys (`max_lines`, `stale_after_days`, `inject_every_n_turns`) are plugin internals and are no longer injected. Falls back to raw JSONC if parsing fails.
- `last_updated` field in topic file frontmatter: set equal to `created` on first write; updated to the current datetime on every subsequent `write_memory` call to the same topic. Legacy files without `last_updated` receive it automatically on the next append.
- ISO 8601 datetime format throughout: `created`, `last_updated` (frontmatter), MEMORY.md index dates, and section headings now use `YYYY-MM-DDTHH:MM:SS±HH:MM` (local timezone) instead of bare `YYYY-MM-DD`.

### Changed

- `today()` replaced by `nowIso()` — returns a local-timezone ISO 8601 datetime string (e.g. `2026-08-10T09:53:38+08:00`).
- `getCache()` now stores `renderedRules` (rendered markdown) instead of raw `rules` string; the rendered form is what gets injected.
- `maintainIndex` stale-stamping regex updated to match full ISO datetime tokens so `[stale?]` is stamped after the full timestamp, not mid-string.
- `INITIAL_RULES_JSONC` replaces `INITIAL_RULES` as the bootstrap template.
- `MEMORY_RULES_LEGACY` path constant added to support migration detection.
- Smoke tests updated: `writeRules()` helper writes `RULES.jsonc`; inline `parseConfigCopy` functions replaced with `parseRulesCopy` using JSONC logic; new assertions for ISO `created`/`last_updated` in frontmatter and ISO datetime in index lines. 3 new migration tests added (total: 22 tests).

### Notes

- Existing `~/.config/opencode/memory/RULES.md` files are automatically migrated to `RULES.jsonc` the first time the updated plugin loads. No manual action required.
- The `RULES.jsonc` format is a strict superset of the old `RULES.md` config: all three numeric config keys carry over. The `always_persist`, `never_persist`, `always_ask` arrays are new structured fields that replace the free-form markdown prose sections — same content, now machine-readable.
- Token overhead for rules injection decreases slightly vs v0.2.0 because config scalars are no longer injected; ISO datetimes in index lines add ~4 tokens/entry vs bare dates.

## [0.2.0] - 2026-08-05

### Added

- `experimental.session.compacting` hook: injects current `MEMORY.md` and `RULES.md` content into the compaction context so memory survives context compression cleanly
- `tool.execute.after` hook: sets `_dirty = true` when `write_memory`, `remove_memory`, or `pin_memory` completes, signalling that the index has changed
- Conditional system prompt injection: `MEMORY.md` and `RULES.md` are now injected on the first turn, after any memory tool mutation, and every `inject_every_n_turns` turns (default: 5). All other turns skip injection, saving tokens on long sessions while keeping memory salient.
- `inject_every_n_turns` config in `RULES.md` `## Config` section (default 5; minimum 1): controls the periodic re-injection interval. Set to `1` to restore every-turn injection.

### Changed

- `MEMORY.md` and `RULES.md` are no longer read from disk on every turn. They are loaded once per session into an in-process cache and invalidated after any tool call that mutates `MEMORY.md` (`write_memory`, `remove_memory`, `pin_memory`). Cache is process-global; safe for single-user plugin (upgrade path: per-session Map if multi-session needed).
- `system.transform` hook reads from the cache and injects only when `_injectedOnce === false`, `_dirty === true`, or `_turnCount % injectEveryNTurns === 0`
- `maintainIndex` calls inside tools now use the cached config instead of re-reading `RULES.md`
- `experimental.session.compacting` forces a fresh disk read (`forceRefresh`) and resets `_injectedOnce`, `_dirty`, and `_turnCount` so the first turn after compaction re-injects memory
- `parseConfig()` now parses `inject_every_n_turns` in addition to `max_lines` and `stale_after_days`
- `README` update: new section `Disk I/O and injection overhead`, and subsection `Representative models by tier`; updated `Model compatibility`
- `npm test` script added to `package.json` - for when someone decides to create their own smoketest procedure

### Notes

- Smoke test suite (`test.mjs`, gitignored): 19 tests covering `parseConfig` clamping, `write_memory`/`pin_memory`/`remove_memory` tool behaviour, dirty flag path (`tool.execute.after` → `system.transform`), `session.compacting` reset, cache invalidation, and `plugin.config` hook registration.

### Known limitation

Manual edits to `MEMORY.md` or `RULES.md` made between turns (outside of tool calls) will not be reflected in the injected system prompt until the next tool call, the next periodic re-injection turn, or a compaction event. This is an intentional trade-off; for a local developer tool the cost is acceptable.

## [0.1.1] - FIRST BETA RELEASE (REITERATION) + README - 2026-07-27

### Added

- Native plugin tools: `write_memory`, `remove_memory`, `pin_memory` - registered via the `tool` hook; replace raw file operations for all memory writes
- `write_memory`: creates topic file with YAML frontmatter stamped by the plugin; appends under `## YYYY-MM-DD` heading on update; upserts `MEMORY.md` index automatically
- `remove_memory`: removes index entry by case-insensitive name/filename match; refuses if entry is pinned
- `pin_memory`: pins or unpins an index entry via a boolean arg; returns before/after line confirmation
- Index maintenance (`maintainIndex`): orphan removal, duplicate removal, `[stale?]` stamping — runs after every tool call, never on session load
- `[stale?]` token: stamped on index entries older than `stale_after_days`; self-heals when topic is updated; pinned and dateless entries never flagged
- `unpin` subcommand to `/memory` command
- `stale_after_days` config in `RULES.md` `## Config` section (default 180; `0` = disabled)
- `findIndexEntry()` shared helper: extracted from duplicated search loops in `remove_memory` and `pin_memory`
- `engines: { node: ">=18" }` in `package.json`
- `.opencode/.npmignore`: excludes `node_modules/`, and dev configs from published tarball

### Fixed

- `write_memory` slug mismatch: tool now scans the index for a case-insensitive exact name match before deriving a slug — prevents creating a duplicate file when the existing filename differs from what the slug would produce
- `findIndexEntry` now lowercases the search arg internally; callers no longer need to pre-lowercase
- `/memory` show branch now instructs the agent to display topic name only — prevents markdown link syntax rendering in the output table

### Changed

- `parseMaxLines()` replaced by `parseConfig()` — parses both `max_lines` and `stale_after_days` in one pass
- All `/memory` write branches (`store`, `pin`, `remove`) now delegate to native tools instead of instructing the agent to edit files directly (HUGE STUFF!)
- `write_memory` index read deduplicated — one `fs.readFileSync` call reused for topic-name lookup and upsert
- `upsertIndexLine` dead variable removed; `pinToken` moved to the append path only
- Unused `name` destructure removed from `maintainIndex`; `result.push` now uses `parsed.name` directly
- `SKILL.md` bumped to `v0.1.0`: removed manual frontmatter instruction, added tools reference table, updated write and cap-remediation procedures, added `[stale?]` documentation
- `zod` added to root `dependencies` (required for tool arg schemas at runtime)
- updated README to remove 'On-going' work that has been completed (localizing logic) (my bad on forgetting to update/remove the Updates section)

## [0.1.0] - FIRST BETA RELEASE - 2026-07-27

### Added

- Native plugin tools: `write_memory`, `remove_memory`, `pin_memory` - registered via the `tool` hook; replace raw file operations for all memory writes
- `write_memory`: creates topic file with YAML frontmatter stamped by the plugin; appends under `## YYYY-MM-DD` heading on update; upserts `MEMORY.md` index automatically
- `remove_memory`: removes index entry by case-insensitive name/filename match; refuses if entry is pinned
- `pin_memory`: pins or unpins an index entry via a boolean arg; returns before/after line confirmation
- Index maintenance (`maintainIndex`): orphan removal, duplicate removal, `[stale?]` stamping — runs after every tool call, never on session load
- `[stale?]` token: stamped on index entries older than `stale_after_days`; self-heals when topic is updated; pinned and dateless entries never flagged
- `unpin` subcommand to `/memory` command
- `stale_after_days` config in `RULES.md` `## Config` section (default 180; `0` = disabled)
- `findIndexEntry()` shared helper: extracted from duplicated search loops in `remove_memory` and `pin_memory`
- `engines: { node: ">=18" }` in `package.json`
- `.opencode/.npmignore`: excludes `node_modules/`, and dev configs from published tarball

### Fixed

- `write_memory` slug mismatch: tool now scans the index for a case-insensitive exact name match before deriving a slug — prevents creating a duplicate file when the existing filename differs from what the slug would produce
- `findIndexEntry` now lowercases the search arg internally; callers no longer need to pre-lowercase
- `/memory` show branch now instructs the agent to display topic name only — prevents markdown link syntax rendering in the output table

### Changed

- `parseMaxLines()` replaced by `parseConfig()` — parses both `max_lines` and `stale_after_days` in one pass
- All `/memory` write branches (`store`, `pin`, `remove`) now delegate to native tools instead of instructing the agent to edit files directly (HUGE STUFF!)
- `write_memory` index read deduplicated — one `fs.readFileSync` call reused for topic-name lookup and upsert
- `upsertIndexLine` dead variable removed; `pinToken` moved to the append path only
- Unused `name` destructure removed from `maintainIndex`; `result.push` now uses `parsed.name` directly
- `SKILL.md` bumped to `v0.1.0`: removed manual frontmatter instruction, added tools reference table, updated write and cap-remediation procedures, added `[stale?]` documentation
- `zod` added to root `dependencies` (required for tool arg schemas at runtime)

## [0.0.4] - 2026-07-21

### Added

- `RULES.md` injection into system prompt on every turn
- `max_lines` config in `RULES.md` `## Config` section (default 200; range 50–500)
- Truncation warning comment injected when index exceeds line limit or 25 KB
- `[pin]` and `YYYY-MM-DD` metadata conventions in index entries
- Cap remediation procedure in `SKILL.md`

### Changed

- `SKILL.md` bumped to `v0.0.2`

## [0.0.3] - 2026-07-21

### Added

- Initial `/memory` slash command with show, store, pin, remove branches

## [0.0.2] - 2026-07-20

### Fixed

- Unset `NODE_AUTH_TOKEN` in publish workflow to allow OIDC fallback for npm Trusted Publishing

## [0.0.1] - 2026-07-20

- Initial release
