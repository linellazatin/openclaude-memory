import fs from 'fs';
import path from 'path';
import {
  MEMORY_DIR, MEMORY_CONFIG, INITIAL_MEMORY, parseIndexLine,
  stripJsonc, readMemoryRules, parseRules, getMemoryDir, getMemoryIndex, getDirtySentinel,
  ensureMemoryDir, atomicWriteFileSync, sleep, acquireLock, releaseLock, maybeCarryOverToSharedDir,
  isSafeFilename,
} from './ocl-memory-shared.mjs';

const MAX_BYTES = 50 * 1024;

const CONSOLIDATION_PROMPT = `Review the current conversation for facts, decisions, or discoveries that match the "always_persist" rules in ${MEMORY_CONFIG} but have not yet been written to memory. For each one found, call write_memory with an appropriate topic, content, summary, and pin value.

Then write or update a topic named "Last Session Recap" (filename last-session-recap.md) summarizing what was accomplished this session, using mode: "replace" so it always reflects only the most recent session. Do not pin this entry — it is meant to be overwritten every session.

If nothing new was found to persist, say so plainly and do not call any tools.`;

// Consolidation prompt used after automatic compaction. Instead of asking the
// agent to re-scan the whole conversation (the compaction LLM already did that),
// it feeds the just-generated compaction summary as the input. One fewer full
// scan. It also tells the agent to resume any pending work afterwards, so
// consolidation does not silently abandon an in-progress task.
const buildCompactConsolidationPrompt = (summary) => `The conversation was just compacted. Below is the compaction summary of the work so far.

<compaction-summary>
${summary}
</compaction-summary>

Based on the summary above, identify any facts, decisions, or discoveries that match the "always_persist" rules in ${MEMORY_CONFIG} but have not yet been written to memory. For each one, call write_memory with an appropriate topic, content, summary, and pin value.

Then write or update a topic named "Last Session Recap" (filename last-session-recap.md) summarizing what was accomplished this session, using mode: "replace" so it always reflects only the most recent session. Do not pin this entry — it is meant to be overwritten every session.

After consolidating, continue with any pending work described in the summary's "Next Move" section. If there is no pending work, stop.`;

// --- In-process cache ---
// Loaded once per session (or after any tool mutation / compaction).
// Avoids re-reading memory.jsonc and MEMORY.md on every turn.
// Caveat: manual edits to memory.jsonc or MEMORY.md between turns are not
// reflected until the next tool call or compaction event.
// process-global state; safe for single-user plugin.
// Upgrade path: per-session Map keyed by session ID if multi-session needed.
let _cache = null;

// Injection state — controls whether system.transform injects memory this turn.
// _injectedOnce: false until first injection; reset to false after compaction.
// _dirty: set to true by tool.execute.after when a memory tool mutates MEMORY.md;
//         cleared after system.transform injects the updated content.
// _turnCount: incremented each turn; used to enforce the inject_every_n_turns interval.
let _injectedOnce = false;
let _dirty = false;
let _turnCount = 0;

async function getCache(forceRefresh = false) {
  // If TUI mutated MEMORY.md directly, it writes a sentinel file to signal us.
  // The sentinel lives alongside whichever dir was active last time we
  // resolved (_cache.memDir) — matches wherever the TUI actually wrote it.
  if (_cache && !forceRefresh && fs.existsSync(getDirtySentinel(_cache.memDir))) {
    try { fs.unlinkSync(getDirtySentinel(_cache.memDir)); } catch {}
    _cache = null;
    _dirty = true;
  }
  if (!_cache || forceRefresh) {
    const rules = readMemoryRules();
    const config = parseRules(rules);
    await maybeCarryOverToSharedDir(config);
    const renderedRules = renderRulesForInjection(rules);
    const memDir = getMemoryDir(config);
    const content = readMemoryIndex(config.maxLines, memDir);
    _cache = { renderedRules, config, content, memDir };
  }
  return _cache;
}

function invalidateCache() {
  _cache = null;
}

// Transforms memory.jsonc content into markdown for agent injection.
// Renders only the behavioral array keys (always_persist, never_persist, always_ask)
// as markdown bullet lists. Scalar config keys are plugin internals — not injected.
// Falls back to raw content if parsing fails (e.g. heavily customised JSONC).
function renderRulesForInjection(raw) {
  if (!raw) return null;
  try {
    const obj = JSON.parse(stripJsonc(raw));
    const sections = [
      ['always_persist', 'Always persist'],
      ['never_persist', 'Never persist'],
      ['always_ask', 'Always ask before persisting (non-overridable)'],
    ];
    const parts = sections
      .filter(([key]) => Array.isArray(obj[key]) && obj[key].length)
      .map(([key, heading]) => `### ${heading}\n${obj[key].map(i => `- ${i}`).join('\n')}`);
    return parts.length ? parts.join('\n\n') : raw;
  } catch {
    return raw; // unparseable JSONC — inject as-is
  }
}

function readMemoryIndex(maxLines, memDir) {
  try {
    const indexPath = path.join(memDir, 'MEMORY.md');
    if (!fs.existsSync(indexPath)) {
      ensureMemoryDir(memDir);
      atomicWriteFileSync(indexPath, INITIAL_MEMORY);
      return INITIAL_MEMORY;
    }
    const raw = fs.readFileSync(indexPath, 'utf8');
    const lines = raw.split('\n');
    if (lines.length > maxLines) {
      return lines.slice(0, maxLines).join('\n') + `\n\n<!-- memory truncated: MEMORY.md exceeds ${maxLines}-line limit; shorten the index -->`;
    }
    if (Buffer.byteLength(raw) > MAX_BYTES) {
      return lines.slice(0, maxLines).join('\n') + `\n\n<!-- memory truncated: MEMORY.md exceeds ${Math.round(MAX_BYTES / 1024)} KB size limit; shorten the index -->`;
    }
    return raw;
  } catch {
    return null;
  }
}

// --- Index line parsing ---
// parseIndexLine now lives in ocl-memory-shared.mjs (needed there for the
// shared_dir merge logic too) — imported above.

function nowIso() {
  const now = new Date();
  const off = -now.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
  const mm = String(Math.abs(off) % 60).padStart(2, '0');
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 19) + sign + hh + ':' + mm;
}

function daysSince(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

// --- Index maintenance ---
// Runs after every tool call that mutates MEMORY.md.
// Handles: orphan removal, duplicate removal, [stale?] stamping/removal.
// Does NOT run on session load — file only mutated when agent calls a tool.

function maintainIndex(lines, config, memDir = MEMORY_DIR) {
  const { staleAfterDays } = config;

  // Pass 1: for each filename, pick the entry with the most-recent date; skip orphans.
  const best = new Map(); // filename -> raw line (winner)
  for (const line of lines) {
    const parsed = parseIndexLine(line);
    if (!parsed) continue;
    const { filename } = parsed;
    if (!isSafeFilename(filename)) continue; // corrupted/unsafe entry — drop like an orphan
    if (!fs.existsSync(path.join(memDir, filename))) continue;
    const date = (parsed.rest.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
    const prev = best.get(filename);
    const prevDate = prev ? ((parseIndexLine(prev).rest.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || '') : '';
    if (!prev || date > prevDate) best.set(filename, line);
  }

  // Pass 2: rebuild preserving non-entry lines; emit each winner once at first occurrence.
  const emitted = new Set();
  const result = [];
  for (const line of lines) {
    const parsed = parseIndexLine(line);
    if (!parsed) { result.push(line); continue; }
    const { filename } = parsed;
    if (!best.has(filename) || emitted.has(filename)) continue;
    emitted.add(filename);

    // Apply stale stamping to the winner's rest
    const winner = parseIndexLine(best.get(filename));
    let rest = winner.rest;
    const isPinned = rest.includes('[pin]');
    if (!isPinned && staleAfterDays > 0) {
      const dateMatch = rest.match(/(\d{4}-\d{2}-\d{2}(?:T[\d:.+-]+)?)/);
      if (dateMatch) {
        const age = daysSince(dateMatch[1]);
        if (age !== null && age > staleAfterDays) {
          if (!rest.includes('[stale?]')) rest = rest.replace(dateMatch[1], dateMatch[1] + ' [stale?]');
        } else {
          rest = rest.replace(' [stale?]', '');
        }
      }
    }

    result.push(winner.prefix + winner.name + winner.mid + rest);
  }

  return result;
}

// --- Shared index search helper ---

function findIndexEntry(lines, search) {
  const s = search.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseIndexLine(lines[i]);
    if (!parsed) continue;
    if (parsed.name.toLowerCase().includes(s) || parsed.filename.toLowerCase().includes(s))
      return { idx: i, parsed };
  }
  return null;
}

// --- Slug generation ---

function toSlug(topic) {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

// --- Index upsert ---
// Finds and updates an existing index line for the given filename, or appends a new one.
// Returns updated lines array.

function upsertIndexLine(lines, filename, name, summary, pin) {
  const dateStr = nowIso();

  for (let i = 0; i < lines.length; i++) {
    const parsed = parseIndexLine(lines[i]);
    if (!parsed) continue;
    if (parsed.filename === filename) {
      const effectivePin = parsed.rest.includes('[pin]') || pin;
      const pinToken = effectivePin ? ' [pin]' : '';
      lines[i] = `- [${name}](${filename})${pinToken} ${dateStr} -- ${summary}`;
      return lines;
    }
  }

  // New entry
  const pinToken = pin ? ' [pin]' : '';
  lines.push(`- [${name}](${filename})${pinToken} ${dateStr} -- ${summary}`);
  return lines;
}

// --- Tool definitions ---

const MEMORY_TOOL_NAMES = new Set(['write_memory', 'remove_memory', 'pin_memory']);

const tools = {
  write_memory: {
    description: 'Write or update a memory topic. Creates a new topic file or appends to an existing one. Updates the MEMORY.md index automatically. Use this instead of raw Write/Edit tools for all memory operations.',
    args: {
      topic:   { type: 'string', description: 'Topic name, e.g. "PostgreSQL Setup" or "Homelab Server"' },
      content: { type: 'string', description: 'The content to write or append to the topic file' },
      summary: { type: 'string', description: 'One-line summary for the MEMORY.md index entry' },
      pin:     { type: 'boolean', description: 'Pin this entry so it is never a cleanup candidate', default: false },
      mode:    { type: 'string', enum: ['append', 'replace'], description: 'append (default): add content under a new date heading. replace: overwrite the body, keeping frontmatter and advancing last_updated.', default: 'append' },
    },
    async execute(args) {
      const { topic, content, summary, pin, mode = 'append' } = args;
      if (typeof topic !== 'string' || !topic.trim()) return 'Error: topic is required and must be a non-empty string.';
      if (typeof content !== 'string') return 'Error: content is required and must be a string.';
      if (typeof summary !== 'string') return 'Error: summary is required and must be a string.';
      const pinBool = pin === true || pin === 'true';

      const { config } = await getCache();
      const memDir = getMemoryDir(config);
      const memIndex = getMemoryIndex(config);
      ensureMemoryDir(memDir);

      const lockPath = await acquireLock(memDir);
      try {
        // Read index once — reuse for topic-name lookup and upsert
        const rawIndex = fs.existsSync(memIndex)
          ? fs.readFileSync(memIndex, 'utf8')
          : INITIAL_MEMORY;

        // Check if an existing index entry matches this topic name — use its filename if so
        let filename = toSlug(topic) + '.md';
        let matchedExisting = false;
        for (const line of rawIndex.split('\n')) {
          const parsed = parseIndexLine(line);
          if (parsed && parsed.name.toLowerCase() === topic.toLowerCase()) {
            filename = parsed.filename;
            matchedExisting = true;
            break;
          }
        }

        // Genuinely new topic (no existing entry matched by name) whose slug
        // collides with an unrelated file already on disk — bump a numeric
        // suffix instead of silently sharing/overwriting that file's content.
        if (!matchedExisting) {
          const base = filename.replace(/\.md$/, '');
          let n = 2;
          while (fs.existsSync(path.join(memDir, filename))) {
            filename = `${base}-${n}.md`;
            n++;
          }
        }
        const topicPath = path.join(memDir, filename);

        let isNew = false;
        if (!fs.existsSync(topicPath)) {
          isNew = true;
          const now = nowIso();
          const frontmatter = `---\nname: ${topic}\ndescription: ${summary}\ncreated: ${now}\nlast_updated: ${now}\nmetadata:\n  node_type: memory\n---\n\n`;
          atomicWriteFileSync(topicPath, frontmatter + content + '\n');
        } else if (mode === 'replace') {
          const now = nowIso();
          const existing = fs.readFileSync(topicPath, 'utf8');
          const fmMatch = existing.match(/^(---\n[\s\S]*?\n---\n)/);
          let fm = fmMatch ? fmMatch[1] : '';
          if (fm.includes('last_updated:')) {
            fm = fm.replace(/^(last_updated:\s*).*$/m, `$1${now}`);
          } else if (fm.includes('created:')) {
            fm = fm.replace(/^(created:.*)$/m, `$1\nlast_updated: ${now}`);
          }
          atomicWriteFileSync(topicPath, fm + '\n' + content + '\n');
        } else {
          const now = nowIso();
          const existing = fs.readFileSync(topicPath, 'utf8');
          let body;
          if (existing.includes('last_updated:')) {
            body = existing.replace(/^(last_updated:\s*).*$/m, `$1${now}`);
          } else if (existing.includes('created:')) {
            body = existing.replace(/^(created:.*)$/m, `$1\nlast_updated: ${now}`);
          } else {
            body = existing;
          }
          atomicWriteFileSync(topicPath, body + `\n## ${now}\n\n` + content + '\n');
        }

        // Update index
        let lines = rawIndex.split('\n');

        lines = upsertIndexLine(lines, filename, topic, summary, pinBool);
        lines = maintainIndex(lines, config, memDir);

        atomicWriteFileSync(memIndex, lines.join('\n'));
        invalidateCache(); // nuke cache so the next caller re-reads the fresh index

        return `Memory ${isNew ? 'created' : 'updated'}: ${topicPath}\nIndex updated: ${memIndex}\nEntry: [${topic}](${filename}) ${nowIso()} -- ${summary}`;
      } finally {
        releaseLock(lockPath);
      }
    },
  },

  remove_memory: {
    description: 'Remove a topic entry from the MEMORY.md index. The topic file on disk is preserved. Pinned entries cannot be removed.',
    args: {
      topic: { type: 'string', description: 'Topic name or partial filename to search for (case-insensitive)' },
    },
    async execute(args) {
      const { topic } = args;
      if (typeof topic !== 'string' || !topic.trim()) return 'Error: topic is required and must be a non-empty string.';
      const search = topic.toLowerCase();

      const { config } = await getCache();
      const memDir = getMemoryDir(config);
      const memIndex = getMemoryIndex(config);

      if (!fs.existsSync(memIndex)) {
        return 'No memory index found.';
      }

      const lockPath = await acquireLock(memDir);
      try {
        const raw = fs.readFileSync(memIndex, 'utf8');
        const lines = raw.split('\n');

        const found = findIndexEntry(lines, search);
        if (!found) {
          return `No matching entry found for "${topic}".`;
        }
        const { idx: foundIdx, parsed } = found;

        if (!isSafeFilename(parsed.filename)) {
          return `Entry has an unsafe filename (${parsed.filename}) and was not modified. This may indicate a corrupted index — inspect it manually.`;
        }

        if (parsed.rest.includes('[pin]')) {
          return `Entry is pinned and cannot be removed. Use pin_memory with pin: false to unpin it first.`;
        }

        const removedLine = lines[foundIdx];
        lines.splice(foundIdx, 1);

        const maintained = maintainIndex(lines, config, memDir);

        atomicWriteFileSync(memIndex, maintained.join('\n'));
        invalidateCache();

        const topicFile = path.join(memDir, parsed.filename);
        const fileNote = fs.existsSync(topicFile)
          ? `Topic file ${parsed.filename} still exists on disk.`
          : `Topic file ${parsed.filename} was not found on disk.`;

        return `Index entry removed: ${removedLine.trim()}\n${fileNote}`;
      } finally {
        releaseLock(lockPath);
      }
    },
  },

  pin_memory: {
    description: 'Pin or unpin a memory index entry. Pinned entries are never flagged as stale and cannot be removed.',
    args: {
      topic: { type: 'string', description: 'Topic name or partial filename to search for (case-insensitive)' },
      pin:   { type: 'boolean', description: 'true to pin, false to unpin' },
    },
    async execute(args) {
      const { topic, pin } = args;
      if (typeof topic !== 'string' || !topic.trim()) return 'Error: topic is required and must be a non-empty string.';
      const search = topic.toLowerCase();
      const pinBool = pin === true || pin === 'true';

      const { config } = await getCache();
      const memDir = getMemoryDir(config);
      const memIndex = getMemoryIndex(config);

      if (!fs.existsSync(memIndex)) {
        return 'No memory index found.';
      }

      const lockPath = await acquireLock(memDir);
      try {
        const raw = fs.readFileSync(memIndex, 'utf8');
        const lines = raw.split('\n');

        const found = findIndexEntry(lines, search);
        if (!found) {
          return `No matching entry found for "${topic}".`;
        }
        const { idx: foundIdx, parsed } = found;

        const line = lines[foundIdx];
        const alreadyPinned = parsed.rest.includes('[pin]');

        if (pinBool && alreadyPinned) return `Already pinned: ${line.trim()}`;
        if (!pinBool && !alreadyPinned) return `Already unpinned: ${line.trim()}`;

        const newRest = pinBool
          ? ' [pin]' + parsed.rest
          : parsed.rest.replace(/\s*\[pin\]/, '');

        const before = line.trim();
        lines[foundIdx] = parsed.prefix + parsed.name + parsed.mid + newRest;
        const after = lines[foundIdx].trim();

        const maintained = maintainIndex(lines, config, memDir);

        atomicWriteFileSync(memIndex, maintained.join('\n'));
        invalidateCache();

        return `${pinBool ? 'Pinned' : 'Unpinned'}.\nBefore: ${before}\nAfter:  ${after}`;
      } finally {
        releaseLock(lockPath);
      }
    },
  },
};

// --- Plugin export ---

export default async (input) => {
  const client = input && input.client;
  const skillsDir = new URL('../../skills', import.meta.url).pathname;

  // Fetch the text of the most recent compaction summary for a session.
  // opencode stores it as an assistant message with `summary === true`.
  // Returns the joined text, or null if none found / the call fails.
  const fetchLatestCompactionSummary = async (sessionID) => {
    try {
      const res = await client.session.messages({ path: { id: sessionID } });
      const messages = (res && res.data) || res;
      if (!Array.isArray(messages)) return null;
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.info && m.info.role === 'assistant' && m.info.summary === true) {
          const text = (m.parts || [])
            .filter((p) => p && p.type === 'text' && p.text)
            .map((p) => p.text)
            .join('\n')
            .trim();
          return text || null;
        }
      }
      return null;
    } catch {
      return null;
    }
  };

  return {
    config: async (config) => {
      // Register skills directory
      config.skills = config.skills || {};
      config.skills.paths = config.skills.paths || [];
      if (!config.skills.paths.includes(skillsDir)) {
        config.skills.paths.push(skillsDir);
      }

      // Resolve the active memory dir/index once at startup for display in the
      // command template. If shared_dir is toggled later, this stays stale
      // until the next restart — same one-time-resolution behavior the rest
      // of the plugin already has for config.
      const { config: memConfig } = await getCache();
      const activeDir = getMemoryDir(memConfig);
      const activeIndex = getMemoryIndex(memConfig);

      // Register /memory command
      if (!config.command) config.command = {};
      config.command['memory'] = {
        description: '/memory → show index | /memory <text> → store | /memory pin <topic> → pin | /memory unpin <topic> → unpin | /memory remove <topic> → remove entry | /memory consolidate → consolidate session',
        template: `Memory dir: ${activeDir}
Memory index: ${activeIndex}

Arguments: $ARGUMENTS

## No arguments: show index

Read ${activeIndex}. Display each entry as a table with columns: Topic (name only — no markdown links, no filenames), Date, Pinned (yes/no), Stale (yes/no). List all .md files in ${activeDir}. Do not write anything.

After listing, append this legend:
Tip: /memory <text> to store  |  /memory pin <topic> to pin  |  /memory unpin <topic> to unpin  |  /memory remove <topic> to remove  |  /memory consolidate to consolidate this session

## Arguments start with "remove ": remove an index entry

The text after "remove " is the topic to find. Call the remove_memory tool:
  remove_memory({ topic: "<the text after 'remove '>" })

The tool will refuse if the entry is pinned and report the reason.

## Arguments start with "pin ": pin an entry

The text after "pin " is the topic to find. Call the pin_memory tool:
  pin_memory({ topic: "<the text after 'pin '>", pin: true })

## Arguments start with "unpin ": unpin an entry

The text after "unpin " is the topic to find. Call the pin_memory tool:
  pin_memory({ topic: "<the text after 'unpin '>", pin: false })

## Arguments are exactly "consolidate": consolidate memory from this session

${CONSOLIDATION_PROMPT}

## Arguments provided (not starting with "pin ", "unpin ", or "remove ", and not exactly "consolidate"): store a memory

Treat the arguments as a fact or note to persist. Decide the topic, a slug filename, a one-line summary, and whether the topic is permanent (hardware, user identity, core workflows = pin it). Then call the write_memory tool:
  write_memory({ topic: "<topic name>", content: "<the full fact or note>", summary: "<one-line summary>", pin: <true|false> })

The tool creates a new topic file or appends to an existing one, and updates the MEMORY.md index automatically.

Any text including single words is treated literally as content to store. Do not interpret "show", "list", or similar words as subcommands unless the full argument starts with "pin ", "unpin ", or "remove ", or is exactly "consolidate".`,
      };
    },

    tool: tools,

    // Set _dirty when a memory tool mutates MEMORY.md so system.transform
    // knows to re-inject the updated index on the next turn.
    'tool.execute.after': async (input, _output) => {
      if (MEMORY_TOOL_NAMES.has(input.tool)) {
        _dirty = true;
      }
    },

    // Inject memory into system prompt on:
    //   1. First turn of the session (_injectedOnce === false)
    //   2. Any turn following a memory tool mutation (_dirty === true)
    //   3. Every N turns per inject_every_n_turns config (default: 5)
    // All other turns skip injection, saving tokens while keeping memory salient.
    'experimental.chat.system.transform': async (_input, output) => {
      _turnCount++;
      const { renderedRules, content, config, memDir } = await getCache();
      const shouldInject = !_injectedOnce || _dirty || (_turnCount % config.injectEveryNTurns === 0);

      if (shouldInject) {
        if (content) {
          output.system.push(`## Global Memory\n\nThe following is your persistent memory index. It persists across all sessions. Topic files referenced here can be read on-demand for detail.\n\nMemory dir: ${memDir}\n\n${content}`);
        }

        if (renderedRules) {
          output.system.push(`## Memory Rules\n\nThe following rules govern what to persist or avoid persisting to memory. Edit ${MEMORY_CONFIG} to customise.\n\n${renderedRules}`);
        }

        _injectedOnce = true;
        _dirty = false;
      }
    },

    'experimental.session.compacting': async (_input, output) => {
      // Force a fresh read so the compaction prompt gets up-to-date memory state.
      const { renderedRules, content } = await getCache(true);

      if (content) {
        output.context.push(`## Global Memory (current index)\n\n${content}`);
      }

      if (renderedRules) {
        output.context.push(`## Memory Rules\n\n${renderedRules}`);
      }

      // Reset so the first turn after compaction re-injects memory into the
      // system prompt — the agent's context window was just replaced.
      _injectedOnce = false;
      _dirty = false;
      _turnCount = 0;
    },

    // After automatic compaction, opencode sends a synthetic "continue"
    // message by default (output.enabled defaults to true, native behavior).
    // If consolidate_on_compact is enabled, suppress that default and run a
    // consolidation pass instead — seeded with the compaction summary opencode
    // just generated, so the agent does not re-scan the whole conversation, and
    // told to resume pending work so an in-progress task is not abandoned.
    //
    // This hook is gated by `input.auto === true` inside opencode's
    // compaction.ts — manual /compact sets auto=false and never reaches here.
    // consolidate_on_compact therefore only fires on overflow-triggered
    // (automatic) compaction. Users who compact manually and want consolidation
    // must run /memory consolidate explicitly. Known gap; no near-term fix.
    'experimental.compaction.autocontinue': async (hookInput, output) => {
      const { config } = await getCache();
      if (!config.consolidateOnCompact || !client) return;
      output.enabled = false;
      try {
        const summary = await fetchLatestCompactionSummary(hookInput.sessionID);
        const text = summary
          ? buildCompactConsolidationPrompt(summary)
          : CONSOLIDATION_PROMPT;
        await client.session.prompt({
          path: { id: hookInput.sessionID },
          body: { parts: [{ type: 'text', text }] },
        });
      } catch {
        // best-effort — fall back to the native continue if the prompt call fails
        output.enabled = true;
      }
    },
  };
};
