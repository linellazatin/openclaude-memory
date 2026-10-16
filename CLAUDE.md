# CLAUDE.md

Guidance for AI agents working in this repository.

## What this is

An opencode plugin (`@openlines/openclaude-memory`) giving agents persistent markdown memory across sessions. Plain ES JavaScript + Markdown — no TypeScript, no bundler, no lint, no formatter, zero runtime dependencies. Supports OpenCode V1 (floor 1.18.29) and V2 (2.0.31) from the same entrypoints.

## Commands

```sh
npm test                              # 126 sequential smoke checks + real-process shared writers
npm run test:host:v1                  # real OpenCode 1.18.x server + local fake model (needs OPENCODE_BIN)
npm run test:host:v2                  # real OpenCode 2.0.x server + local fake model
node tests/shared-store-test.mjs /absolute/path/to/openpi-memory/extensions/memory-core.mjs
for file in .opencode/plugins/*.mjs tests/*.mjs; do node --check "$file" || exit; done
# run INSIDE .opencode/ (not root) for @opencode-ai/plugin + @opencode/plugin type hints
cd .opencode && npm install
```

No build / typecheck / lint / format. No single-test runner: `smoke-test.mjs` runs the whole suite (`node:assert`, order-dependent).

## Architecture

Three plugin files in `.opencode/plugins/`, all dual V1/V2:

- **`ocl-memory.mjs`** — server plugin. Default-exports `{ id, setup, server }`: V2 calls `setup` (performs all `registerV2*` registrations), V1 calls `server(input)` → `buildV1Hooks(input)` (the legacy hook object). Published entry `exports["."]`.
- **`ocl-memory-tui.mjs`** — TUI browser (`ctrl+alt+m`). Default-exports `{ id, setup, tui }`: V2 uses promise dialogs + a `keymap.layer`, V1 uses the callback `tui(api)` interface. Published entry `exports["./tui"]`.
- **`ocl-memory-shared.mjs`** — pure logic, NO plugin hooks; imported by both. Path/config resolution, `withLock`/`acquireLock`/`releaseLock` + `LockContendedError`, atomic writes, carry-over, `parseIndexLine`, `isSafeFilename`, `stripJsonc`, `readMemoryRules`.

The two entry-point files stay separate: the type system forbids a server plugin exporting `tui` and a TUI plugin exporting `server` (`TuiPluginModule.server?: never` / `PluginModule.tui?: never`). The shared module is exempt (exports no hooks).

Storage: index at `~/.config/opencode/memory/MEMORY.md` (or `~/.agents/memory/` when `shared_dir`), config at `~/.config/opencode/memory.jsonc`; resolved from `XDG_CONFIG_HOME`/`os.homedir()` at module load. `V2` note: configured plugin paths must be directory form (`index.mjs`/`tui.mjs`); the published package is unaffected (uses `exports`).

Module-level state (no reset API between tests): `ocl-memory.mjs` `_cache` (config/content/stamps) and `_requestCount`; `ocl-memory-shared.mjs` `_carryOverChecked` (set only after success) and `_carryOverPending`.

## Key paths

| Path | Role |
|------|------|
| `.opencode/plugins/ocl-memory.mjs` | Server plugin — hooks/tools/injection/consolidation (`exports["."]`) |
| `.opencode/plugins/ocl-memory-shared.mjs` | Pure shared logic, no hooks |
| `.opencode/plugins/ocl-memory-tui.mjs` | TUI browser (`exports["./tui"]`) |
| `.opencode/command/memory.md` | Static `/memory` fallback; dynamic registration overrides at runtime |
| `skills/memory/SKILL.md` | Agent skill, on-demand; carries `version:` frontmatter |
| `package.json` | Root manifest, published; `files: ["skills/", ".opencode/"]` |
| `tests/smoke-test.mjs` / `shared-store-test.mjs` / `host-test.mjs` / `host-test-v2.mjs` | test suites |
| `docs/` | User-facing prose; behavior-coupled, update on behavior changes |

## Invariants (each was a real bug — do not "simplify" away)

- **No zod — flat args map required.** `args` = `{ topic: {type:'string'}, ... }` per param. opencode's `legacyJsonSchema()` fallback needs FLAT. Wrapping in `{ type:'object', properties }` makes `type`/`required`/`properties` be read as param names → every arg `undefined` (the 0.5.1 outage). V2 derives its object schema from the SAME flat map via `toObjectSchema` (inverse companion — do not mix them up).
- **Tool arg guards return a string, never throw.** Validate `topic` non-empty string, `content`/`summary` as strings first. Empty content/summary allowed; fs failures may throw. `repair_memory` takes no args. Native flat-schema calls must pass `pin` and `mode` explicitly.
- **`pin` coerced via `pin === true || pin === 'true'`, never JS truthiness** (string `"false"` is truthy). Applied in `write_memory`/`pin_memory`.
- **`findIndexEntry` is exact-wins / ambiguous-refuses.** Exact case-insensitive name-or-filename wins; a single substring match is returned; MULTIPLE substring matches → `{ambiguous, names}` and the caller refuses. Never regress to first-substring-wins.
- **`write_memory` collapses + caps `summary` at 500 chars** (`MAX_SUMMARY_LENGTH`) into `cleanSummary` BEFORE first use, so frontmatter description, index line, and result message are identical.
- **`isSafeFilename()` guards filenames read back from `MEMORY.md`.** `toSlug()` only sanitizes NEW write filenames; it is never a validator on read. Guards at every read-time path boundary (`write_memory`/`remove_memory`/`maintainIndex`/`mergeLocalIntoSharedDir`/TUI `parseIndex`+read/mutate). Since 0.6.5 also rejects a leading `.` and `[]()`. `write_memory` guards its own generated slug too (else punctuation-only topic → `.md`, then a silent orphan).
- **`write_memory` slug-collision fallback.** New topic whose slug hits a file owned by a DIFFERENT topic → bump `-2`, `-3`… before touching (pre-fix cross-topic corruption). Same-name rewrite reuses the file.
- **Removals are tombstoned in `.ocl-removed`** before index references drop; topic file preserved. Re-store reclaims only on matching frontmatter identity; unrelated slugs get a numeric suffix. Clear tombstone only after successful publication. Every mutation stays inside `withLock`.
- **`stripJsonc` is string-literal-aware.** A naive `//` strip truncates URL values; since 0.6.5 also strips `/* … */` block comments. `parseRules`/`readMemoryRules` `console.error` before default-fallback. Do not revert to a regex one-liner.
- **Index lines are one physical record — `sanitizeIndexField`.** A topic is one `- [name](file.md) date -- summary` line; sanitize collapses `\r\n` and strips `[]()`. `write_memory` sanitizes `topic` → `cleanTopic` ONCE at the top of `execute()` so slug/match/frontmatter/index line all agree. Topic-file CONTENT is NOT sanitized (newlines are normal markdown).
- **50 KB injection cap is enforced line-by-line.** `readMemoryIndex()` keeps only whole lines fitting `MAX_BYTES` (never `lines.slice(0, maxLines)` after a byte overflow).
- **`readMemoryIndex()` never writes on the read path.** Absent → returns `INITIAL_MEMORY` in-memory only (else an unlocked write under `shared_dir` could clobber a co-tenant's fresh index). `MEMORY.md` first materializes on a locked write.
- **`write_memory` timestamp bump is frontmatter-scoped.** Both modes extract the `^---\n...\n---\n` block and regex only inside it (else a body line beginning `last_updated:` gets rewritten and frontmatter never stamped).
- **Two `package.json` files.** Root is published; `.opencode/package.json` is gitignored (with `node_modules`, `bun.lock`) and holds only type hints (`@opencode-ai/plugin` V1 + `@opencode/plugin` V2).

## shared_dir, locking, cache

- **`memory.jsonc` is the single local config source.** Publish a missing config exclusively before renaming legacy `memory/RULES.jsonc` to `.bak`; preserve a racing creator + existing backups; failed publication keeps the legacy original.
- **`getMemoryDir(config)`/`getMemoryIndex(config)` resolve the active directory; capture before the mutation lock.** Stamp checks detect config/path changes before cache reuse; TUI resolves on open and `/memory` refreshes before executing. No restart for ordinary edits.
- **Carry-over is merge-aware + double-guarded.** `maybeCarryOverToSharedDir()` runs once ever per install: `_carryOverChecked` short-circuits in-process only after full success; `CARRY_OVER_SENTINEL` (`.shared-dir-migrated`) across restarts. MERGES (never skips when shared `MEMORY.md` exists): copy originals under original name; identical bytes → skip; different → `-oclm` suffix. Respects both removal lists (tombstones); an identical pre-existing shared file still gets its missing index line appended so it stays discoverable. One-way copy, no re-run on toggle. `parseIndexLine`/`INITIAL_MEMORY` live in the shared module.
- **`withLock` is the single mutation entry point, fail-closed.** Local waits ~500 ms; shared 2 s + 1 s delay + another 2 s, then `LockContendedError`/`BUSY_MESSAGE`. Capture each acquisition token synchronously before awaiting; release verifies it. `EPERM` means alive; stale reclaim checks PID + inode/mtime; unknown payloads use a 60 s threshold. No atomic compare-and-unlink — not a strict lease guarantee.
- **Repair is additive-only and idempotent.** Scan safe regular `.md` files missing from the index/removal list; append `[stale?]` entries dated from frontmatter; never delete/reorder. Report pre-existing vs added separately. Drift notes above five non-tombstoned missing topics; never auto-repair a co-tenant's possible in-flight write.
- **Recap topic is `ocl-last-session-recap.md` (`"OCL Last Session Recap"`), NOT `last-session-recap`** (openpi reserves that slug and strips it every session). Set in both `CONSOLIDATION_PROMPT` and `buildCompactConsolidationPrompt`. Do not rename to a parenthetical.
- **Topic frontmatter uses quoted names/descriptions** (`JSON.stringify`). Both modes refresh name/description/`last_updated`, preserving `created` + unknown fields. Migration compares whole-file bytes.
- **`.invalidate` is computed from the active directory and never consumed.** TUI writes it atomically; each server cache stamps independently; notification failure must report the index already committed.

## Injection & consolidation

- **Always attach memory/rules.** V1 injects via `experimental.chat.system.transform`; V2 via `ctx.session.hook("context")` pushing `{type:'text',text}` SystemParts. Fresh output every request (other sessions, internal calls) — no first-turn gate. `_requestCount`/`inject_every_n_turns` control forced disk refresh, not injection.
- **Per-file durability:** no-follow reads verify regular descriptors; UI/injection reads bounded before allocation; atomic writes (exclusive temp, flush, cleanup); ordinary publish failures attempt rollback (report paths if rollback fails). Directory entries not fsynced — recoverable drift on abrupt termination.
- **Reads never block on special files:** nonblocking open before verifying regular descriptor. Store reads reject final-component symlinks; trusted config symlinks supported (target stamps in cache).
- **Compaction** forces `getCache(true)` into `output.context` (V1 `experimental.session.compacting`; V2 `ctx.session.hook("compaction")`).
- **`consolidate_on_compact`:** V1 runs via `experimental.compaction.autocontinue` (captures `client` from `input.client`; seeds from `fetchLatestCompactionSummary` → latest assistant with `info.summary===true`, `res.data||res`; fallback full-scan `CONSOLIDATION_PROMPT`). Queues with `noReply: true`, retains agent/model/variant; SDK errors retain native continuation. **V2 has no continuation hook** — a `session.compacted` event loop enqueues an *additional* queued prompt; it cannot replace the running loop (documented limitation).
- **`autocontinue` never fires on manual `/compact`** (upstream gates on `input.auto`; manual is `auto:false`). Consolidation only on automatic compaction; manual consolidation is `/memory consolidate`.

## Testing quirks

- `XDG_CONFIG_HOME` (→ temp) and `OCL_SHARED_MEMORY_HOME` must be set at the TOP of `smoke-test.mjs` BEFORE the plugin `import`s — `MEMORY_DIR`/`SHARED_MEMORY_DIR` are fixed at module load. Both plugin files import the same cached shared module (one shared state instance).
- State (`_cache`, `_requestCount`, `_carryOverChecked`, `_carryOverPending`) is process-global with no reset API; test order is load-bearing.
- Use `experimental.session.compacting({}, makeCompactOutput())` for a forced full refresh, not an injection-state reset.
- Cross-process lock tests wait for child IPC readiness (no fixed sleeps); held-lock check ≥150 ms and below the 2 s window.

## Releasing

- Version bump touches 3 files with NO single source of truth: `package.json` (`version`), `skills/memory/SKILL.md` (`version:`), a dated `## [X.Y.Z]` entry in `CHANGELOG.md`. Publish CI checks consistency. **Current worktree version is 0.7.0.**
- CI publishes on a `v*` tag; `publish.yml` scrapes the release body from `CHANGELOG.md` by matching the `## [<version>]` heading, so that heading MUST equal the tag version (minus `v`). `NODE_AUTH_TOKEN: ''` is intentional (OIDC Trusted Publishing) — never put a real token there.
- CI gates: `test.yml` runs `node --check` + `npm test` on every push/PR; `publish.yml` re-runs both plus the 3-way version-consistency check before publishing. Still run `npm test` + `node --check` locally before tagging.