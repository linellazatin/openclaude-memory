# How opencode keeps memory in context

[Back to README](../README.md)

## Per-request system prompts

OpenCode 1.18.34 constructs a fresh system prompt for each model request and invokes `experimental.chat.system.transform`. A plugin's previous `output.system` mutation is not retained for the next request. Openclaude-memory therefore appends `## Global Memory` and `## Memory Rules` on every invocation, including later steps, other sessions, title generation, and compaction requests. There is no process-global first-turn gate.

## Cache freshness

The index and rendered behavioral rules are cached to avoid repeated content reads. Before reuse, the plugin checks file identity, size, and nanosecond modification/change timestamps for `memory.jsonc`, the active directory, `MEMORY.md`, `.ocl-removed`, and `.invalidate`. A change rebuilds the cache. Config changes also re-resolve `shared_dir`; `/memory` refreshes its directory paths before execution.

`inject_every_n_turns` retains its historical name, but now forces a full disk refresh every N model requests, default 5. This is a process-wide request counter, not a user-turn or session counter. Memory is injected regardless of the interval. Memory tool mutations invalidate the cache; compaction always forces a refresh. TUI notifications are not consumed or deleted, so another server process can observe the same change. Ordinary manual and co-tenant edits are detected through file stamps without a sentinel.

## Compaction and consolidation

`experimental.session.compacting` freshly reads memory into the compaction context. Subsequent model requests also receive their own memory blocks; no injection-state reset is needed.

With `consolidate_on_compact: true`, the automatic continuation hook fetches the latest compaction summary and saves a consolidation prompt with `client.session.prompt({ body: { noReply: true, ... } })`. Saving returns immediately instead of awaiting the session loop that is already running. The queued prompt preserves the active agent, model, and variant. Native continuation is disabled only after a successful API response; failures leave it enabled.

The summary-backed prompt resumes pending work from `Next Move`. If no summary can be fetched, the full-conversation fallback also instructs the agent to resume pending work. Manual `/compact` and automatic compaction paths that replay a user message do not invoke this continuation hook; run `/memory consolidate` explicitly when needed.

## Token cost

The memory blocks form part of every model request's input tokens. Provider prompt caching may discount repeated content, but this plugin does not guarantee free system-prompt tokens or a particular cache hit rate. Increasing `inject_every_n_turns` reduces periodic content rereads, not prompt size or injection frequency. Topic bodies are loaded on demand rather than injected automatically. The index block is capped at configured whole lines and 50 KiB; behavioral rules and tool schemas add their own tokens.

## Verification

`npm run test:host` starts the installed OpenCode server with temporary config and memory paths and a local fake model. It verifies native tool execution, memory on subsequent requests, another session's first request, and automatic consolidation completing without re-entrant deadlock. OpenCode 1.18.34 passed this check; this establishes host integration, not a real model's memory-writing judgment.
