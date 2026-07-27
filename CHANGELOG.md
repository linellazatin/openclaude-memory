# Changelog

All notable changes to this project will be documented in this file.

## [0.1.1] - FIRST BETA RELEASE + README - 2026-07-27

### Changed

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
