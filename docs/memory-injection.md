# How opencode keeps memory in context

[Back to README](../README.md)

A common misconception: that the injected memory index would become "stale" in context as the conversation grows. This is not how opencode works.

## System prompt persistence

opencode builds a system prompt at the start of each session. When this plugin fires its `experimental.chat.system.transform` hook on turn 1, it pushes the `## Global Memory` and `## Memory Rules` blocks into `output.system`. That system prompt is **fixed for the life of the session** — opencode sends it on every LLM call. The agent has the memory index in context on turn 1, turn 10, turn 50. It never disappears mid-session.

There is no token overhead per turn from persistence — the system prompt is part of the request structure, not the conversation messages. You are not paying to "re-send" it each turn; opencode handles this at the API level.

## What re-injection actually does

The plugin re-injects memory on three conditions (not just turn 1):

1. **First turn** — cold load and initial injection.
2. **After any memory tool call** — `write_memory`, `remove_memory`, or `pin_memory` mutate `MEMORY.md`. The dirty flag is set and the next turn injects the updated index so the agent sees the change it just made.
3. **Every `inject_every_n_turns` turns** (default: 5) — the plugin re-reads `MEMORY.md` from disk and re-injects. This is **not** to keep memory present (it already is); it is to pick up **external edits** — manual edits to `MEMORY.md`, changes made via the TUI browser, or edits from another process.

If you never edit memory files manually and only use memory tools, condition 3 is mostly a no-op. The index that was injected on turn 1 is already current.

## Compaction

When opencode triggers automatic context compaction (context overflow prevention), it fires the `experimental.session.compacting` hook. The plugin:

1. Force-reads `MEMORY.md` fresh from disk and pushes it into `output.context` — the compaction summary includes current memory state.
2. Resets `_injectedOnce`, `_dirty`, and `_turnCount` to zero.

After compaction, opencode replaces the agent's context window. The first turn of the new context re-injects memory into the fresh system prompt — the same as session start. Memory does not get lost across compaction.

## Summary

| Scenario | Memory in context? |
|---|---|
| Turn 1 | Injected for the first time |
| Turn 2–4 | Still present via system prompt (no re-injection needed) |
| Turn 5 (default N=5) | Re-injected from disk (freshness check, not presence) |
| After `write_memory` / `remove_memory` / `pin_memory` | Re-injected with updated content |
| After TUI browser edit | Re-injected on next periodic turn or tool call |
| After context compaction | Re-injected on first post-compaction turn |

The `inject_every_n_turns` config value controls how quickly external edits are reflected — it has no effect on whether memory is present. Raise it to save tokens on long sessions; lower it if you frequently edit `MEMORY.md` outside the agent.
</content>
