# Known Limitations & FAQ

[Back to README](../README.md)

## Known limitations

- The store uses advisory locks and atomic replacement of individual files, not a multi-file transaction. Normal write exceptions trigger rollback; abrupt termination or power loss can leave recoverable drift. Directory entries are not fsynced.
- Lock ownership is checked by token and stale reclaim by PID plus inode/mtime. These checks mitigate replacement races but are not an atomic filesystem compare-and-unlink. Cooperating writers on a local filesystem are the supported model; manual writers or network filesystems can violate that model.
- Automatic consolidation depends on OpenCode's continuation hook. Manual `/compact` and automatic user-message replay paths bypass it. Use `/memory consolidate` explicitly when needed.
- Carry-over happens once after success. Changing `shared_dir` switches the active path but does not continuously reconcile both stores.
- Memory is global across sessions and agents. Persist rules guide the model and do not enforce factual accuracy or sensitive-data handling.

## Compatibility

**Which OpenCode release was verified?** OpenCode 1.18.34. Release-source contracts, smoke tests, and a real-server run with a local fake model were checked. The server test covers tool registration/execution, repeated requests, another session, and automatic consolidation. TUI APIs and mutation behavior are checked separately; interactive rendering and older releases have not been revalidated.

**Do I need to restart?** Restart after changing plugin code, skills, or OpenCode plugin registration. Editing `memory.jsonc` or `MEMORY.md` is detected on the next cache check; the TUI resolves the active directory every time it opens, and dynamic `/memory` paths refresh before execution.

## Storage and recovery

**Where is the active store?** Read `shared_dir` from `~/.config/opencode/memory.jsonc`, respecting `XDG_CONFIG_HOME`. False uses `~/.config/opencode/memory/`; true uses `~/.agents/memory/`. Config always stays local. The existence of an old index does not prove that directory is currently active.

**Does enabling shared memory delete local files?** No. Carry-over locks local then shared, copies safe regular topic files, and appends missing index lines. Different-content filename collisions use `-oclm` suffixes; identical content is reused and still gains a missing index line. Tombstones from both directories prevent removed topics from returning. Failed or contended merges retry on a later refresh, and the success sentinel is written only after completion.

**Can I switch off and back on?** Path changes are detected immediately at the next cache check, but the successful migration does not re-run. Writes made in either inactive directory are not automatically reconciled. Local copies remain snapshots; see [shared storage](shared-directory.md).

**Why are topic files missing from the agent's context?** Discovery uses `MEMORY.md`, not a full directory scan. `/memory repair` additively indexes safe regular `.md` files missing from the index, excluding `.ocl-removed` tombstones. It does not delete/reorder existing entries, refresh existing metadata, or recover pin flags that existed only in a lost index. Under shared mode, more than five unindexed non-tombstoned files trigger a maintenance note; repair is never automatic.

**Can a removed file be restored safely?** `write_memory` on the same topic checks frontmatter identity before reclaiming its removed file, then clears its tombstone. A different topic with the same slug receives a new filename instead of appending to or replacing the old topic. The index name is authoritative for already-indexed topics.

**What happens if writing fails halfway through?** Temporary files are cleaned, and ordinary write exceptions attempt to restore the previous topic and index. A rollback failure is reported with the affected paths. Removal records intent before deleting discoverability, so an index-write failure may leave both an indexed entry and a tombstone; the entry remains visible and a deliberate re-store clears the tombstone. Abrupt crashes skip rollback: a new topic may need repair, and an already-indexed topic may have newer frontmatter/body than its index summary.

**Why does a fresh install have no `MEMORY.md` yet?** Missing-index reads return an empty index in memory. The file is created only by a locked mutation or migration, avoiding an unlocked bootstrap that could overwrite a co-tenant's first write.

## Locking and TUI

**What does "memory store is busy" mean?** The mutation could not acquire the active directory lock. Local mode waits about 500 ms; shared mode waits about 2 s, sleeps 1 s, then retries for about 2 s. Neither mode writes unlocked. Retry the operation; do not delete a live holder's lock. `EPERM` is treated as alive, stale reclaim cannot loop indefinitely on an undeletable lock, and each `withLock` call releases only its captured acquisition token.

**Can the TUI remove a pinned entry?** No. It hides that action and rechecks pin protection inside the lock, including a pin added after opening the dialog. Busy/refusal/filesystem results appear as alerts. A cache-notification failure explicitly says the index was updated, rather than pretending the mutation failed entirely.

**Can other tools corrupt shared memory?** Cooperating writers must honor the same `.lock` and atomic-write convention. The coordinated pi implementation locks its startup recap cleanup and leaves missing-index reads in memory too. Each tool keeps its own migration sentinel and collision suffix. Update both implementations; an older co-tenant with unlocked mutations can still race this plugin.

## Config and injection

**Are my manual config edits overwritten?** Existing `memory.jsonc` is read, not rewritten. Exclusive creation preserves a racing creator's file. Legacy config is copied before renaming its original, and an existing `.bak` is preserved. Config symlinks are supported and target edits refresh the cache. Non-regular config files are refused without blocking. Invalid JSONC is logged and scalar settings fall back to defaults without replacing your file; behavioral rules may use the raw-text fallback.

**Does the injection interval save tokens?** No. OpenCode builds fresh system prompts per request, so memory is attached every time. `inject_every_n_turns` now controls forced content refreshes, while file stamps independently detect changes. Provider prompt-cache discounts depend on the provider; system tokens are not intrinsically free. See [memory injection](memory-injection.md).

**Does consolidation resume my task?** Both automatic prompts instruct the agent to resume pending work: from `Next Move` when a summary is available, or from the current conversation otherwise. They preserve agent/model/variant and queue with `noReply: true`, avoiding a call that waits on its own session loop. API errors retain native continuation. Actual persistence and task-following remain model decisions.

**Can I use JSONC comments and trailing commas?** Yes. Line comments, block comments, and trailing commas are stripped outside quoted strings. Literal URLs, globs, `,]`, and `,}` are preserved. Topic names/summaries are sanitized into one physical index record, and topic content remains ordinary multiline markdown.
