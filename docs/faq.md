# Known Limitations & FAQ

[Back to README](../README.md)

## Known limitations

- `consolidate_on_compact` only fires on **automatic** (overflow-triggered) compaction, never on manual `/compact` — confirmed by source analysis this session; see the dedicated FAQ entry below.
- `shared_dir` is a one-time, one-directional migration, not a live toggle — see the FAQ entry on toggling below. Directories can silently drift once you flip it back and forth.
- Injection state (`_cache`, `_injectedOnce`, `_dirty`, `_turnCount` in `ocl-memory.mjs`; `_carryOverChecked` in `ocl-memory-shared.mjs`) is process-global module state. Safe for opencode's current model (one process per session).

## FAQ (post-0.6.0)

Questions that came up while working through the config relocation, `shared_dir`, and consolidation changes shipped in v0.6.0.

**Q: I just upgraded from a pre-0.6.0 version. Did anything of mine get deleted or overwritten?**
No. The config rename (`RULES.jsonc` → `memory.jsonc`) and the `shared_dir` carry-over are both strictly additive — they only ever create new files, rename-in-place (never delete), or copy existing ones. Nothing pre-existing is ever deleted or overwritten. See [First run: upgrading from a pre-0.6.0 install](shared-directory.md#first-run-upgrading-from-a-pre-060-install) for the exact file-by-file trace.

**Q: How do I check whether I'm currently opted in to `shared_dir`?**
Read the `shared_dir` value directly from `~/.config/opencode/memory.jsonc` — it's the only place this is configured, and it's read fresh from disk whenever the in-process cache is invalidated (not cached indefinitely). You can also infer it indirectly: if `~/.agents/memory/MEMORY.md` exists, `shared_dir` has been `true` at least once.

**Q: I opted in to `shared_dir`. Where did my memories go — are my old files gone?**
Your old files are untouched at `~/.config/opencode/memory/`. Opting in copies (never moves) `MEMORY.md` and topic files into `~/.agents/memory/`. The originals stay exactly where they were — no separate backup dir is created, since the copy means nothing is lost anyway.

**Q: If I opt in, then opt out, then opt in again — does everything stay in sync?**
**No — this is the biggest watch-out.** Toggling `shared_dir` is a one-time, one-directional migration, not a live sync:
- The carry-over from `~/.config/opencode/memory/` → `~/.agents/memory/` only ever runs once per process, guarded by "does the shared `MEMORY.md` already exist." Once it's run, it never runs again, even if you toggle off and back on.
- There is **no reverse migration**. Opting out doesn't copy anything from `~/.agents/memory/` back to `~/.config/opencode/memory/` — it just changes which directory gets read/written going forward.
- This means the two directories can silently drift apart: writes made while `shared_dir: true` are invisible once you flip it back to `false`, and vice versa. Nothing is deleted, but whichever directory isn't currently active becomes a stale snapshot.

**What to do about it:** treat `shared_dir` as a deliberate one-way move, not a togglable setting you flip back and forth casually. If you do need to reconcile after toggling, diff `MEMORY.md` and the topic files between the two directories yourself and manually copy over whatever's missing — the plugin will not do this for you.

**Q: Does switching `shared_dir` also affect my `memory.jsonc` config?**
No. `memory.jsonc` is a fixed path (`~/.config/opencode/memory.jsonc`) that is **never** affected by `shared_dir` — only the location of `MEMORY.md` and topic files changes. There's exactly one config file regardless of `shared_dir`'s value, so there's nothing to keep "in sync" on the config side.

**Q: What's `RULES.jsonc.bak` for, and can I delete it?**
It's a one-time safety backup of your legacy `RULES.jsonc`, created automatically the first time `memory.jsonc` was bootstrapped from it. It's inert afterward — nothing reads it again. Safe to keep indefinitely for peace of mind, or delete it once you've confirmed `memory.jsonc` has everything you expect.

**Q: I have two config files now (`memory.jsonc` and the old `RULES.jsonc.bak`). Which one is active?**
`memory.jsonc` is the only one ever read after the initial migration. The legacy `.bak` file is a frozen historical snapshot from the migration moment — editing it does nothing. Always edit `~/.config/opencode/memory.jsonc`.

**Q: I edited `memory.jsonc` directly — will my changes get overwritten?**
No. `memory.jsonc` is only ever written by the plugin when it doesn't exist yet (fresh install or first-time legacy fallback). Once it exists, the plugin only reads it — your manual edits persist and take effect on the next cache refresh (next tool call, next periodic re-injection turn, or the next session).

**Q: Does the shared directory lock/atomic-write behavior protect me from corruption if another tool writes to `~/.agents/memory/` at the same time?**
Yes, on this plugin's side — writes are serialized through a real filesystem advisory lock (`.lock` file, not just an in-process mutex) and applied atomically (write-to-temp-then-rename). This protects against corruption from concurrent opencode sessions, and from any other tool that also honors the same lock convention (e.g. openpi-memory). It does **not** guarantee safety against a tool that ignores the lock file entirely and writes directly — that's a property of the other tool's implementation, not something this plugin can enforce on its own.

**Q: Does the TUI browser (`ctrl+alt+m`) follow `shared_dir` too, or only the server plugin's tools?**
Both. Path/config resolution was extracted into a shared internal module (`ocl-memory-shared.mjs`) that both the server plugin and the TUI plugin import, so they always resolve the exact same active directory for a given `memory.jsonc` state. The TUI re-reads `memory.jsonc` fresh every time you open the browser (`ctrl+alt+m`) — no caching, since it's a low-frequency, user-initiated action — so it picks up `shared_dir` changes immediately, without needing a restart. TUI mutations (pin/unpin/remove) are also now guarded by the same cross-process lock and written atomically, matching the server plugin's tools; this matters once `shared_dir` puts multiple processes/tools in the same directory. The one thing that still requires a session restart to pick up is the *displayed* path in the `/memory` command's static template text — that's a one-time-at-startup convenience string, unrelated to where files actually get read/written.

**Q: Does `consolidate_on_compact` run when I type `/compact` manually?**
**No.** Confirmed by source analysis of opencode's `packages/opencode/src/session/compaction.ts`: the `experimental.compaction.autocontinue` hook that `consolidate_on_compact` depends on is gated by:
```typescript
if (result === "continue" && input.auto) {
  // autocontinue hook fires here
}
```
Manual `/compact` calls `compactSvc.create({ auto: false })` in opencode's HTTP handler, so the hook is never reached — `input.auto` is `false` for every manual compaction, `true` only for automatic (overflow-triggered) compaction. This means `consolidate_on_compact: true` only takes effect when opencode compacts automatically. If you run `/compact` manually and want the same consolidation pass, run `/memory consolidate` explicitly afterwards. Extending this to manual compaction is a known gap with no near-term fix planned — see `AGENTS.md` for the upstream options under consideration.

**Q: If automatic compaction fires in the middle of a task, does `consolidate_on_compact` abandon what the agent was doing?**
No. When `consolidate_on_compact: true` suppresses opencode's native "continue" message and sends its own consolidation prompt, that prompt is seeded with the compaction summary opencode just generated (a structured recap with an "Objective", "Work State", and "Next Move" section) and explicitly tells the agent to resume the pending work from "Next Move" after consolidating. So the agent persists the session's facts *and* picks the task back up. Two other points worth knowing:
- **Cost:** because the prompt reuses the already-generated compaction summary instead of re-reading the whole conversation, consolidation costs one fewer full-conversation scan than `/memory consolidate` run manually.
- **Fallback:** if the summary can't be fetched (e.g. the messages API call fails, or no summary message is found), the plugin falls back to a full-conversation-scan consolidation prompt — which does *not* include a resume instruction, so in that rare fallback path an in-progress task could still stop. The common path (summary present) resumes correctly.

**Q: When exactly does automatic compaction fire — mid-tool-call?**
No. Automatic compaction fires at the end of a complete LLM step (opencode's `step-finish` event), after all tool calls in that step have finished — never mid-tool-call or mid-stream. The current step completes cleanly, then compaction runs on the next loop iteration. So `consolidate_on_compact` never interrupts a tool call in progress.

**Q: Why did the size caps increase in v0.6.0 (`max_lines` 200→300, byte cap 25KB→50KB)? Does this affect my existing `MEMORY.md`?**
No. The caps only control how much of `MEMORY.md` gets **injected** into the system prompt (and when the truncation warning appears) — they don't touch the file on disk. An existing index that was previously near the old 200-line/25KB limit is now simply further from the new limit; nothing was rewritten or migrated because of this change.
</content>
