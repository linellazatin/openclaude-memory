import fs from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';

const MEMORY_DIR = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'opencode', 'memory'
);
const MEMORY_INDEX = path.join(MEMORY_DIR, 'MEMORY.md');
const MEMORY_RULES = path.join(MEMORY_DIR, 'RULES.md');

const MAX_LINES = 200;
const MAX_BYTES = 25 * 1024;
const DEFAULT_STALE_DAYS = 180;
const DEFAULT_INJECT_INTERVAL = 5;

const INITIAL_MEMORY = `# Memory Index

`;

const INITIAL_RULES = `# Memory Rules

## Always persist
- Any issue solved or fixed
- Server or infrastructure configuration discovered or changed
- Reusable commands or workflows identified
- Hardware, model, or environment facts learned

## Never persist
- Session-specific context that won't apply to future sessions
- Opinions or preferences not confirmed by the user
- Large blocks of code — summarize instead, or link to the file path

## Always ask before persisting (non-overridable)
- Credentials, tokens, API keys
- Personal data
- Anything the user marks as private or ephemeral

## Config
# max_lines: 200         (default; valid range 50–500)
# stale_after_days: 180  (default; 0 = disable age flagging)
# inject_every_n_turns: 5  (default; re-inject memory index every N turns; 1 = every turn)
`;

// --- In-process cache ---
// Loaded once per session (or after any tool mutation / compaction).
// Avoids re-reading RULES.md and MEMORY.md on every turn.
// Caveat: manual edits to RULES.md or MEMORY.md between turns are not
// reflected until the next tool call or compaction event.
let _cache = null;

// Injection state — controls whether system.transform injects memory this turn.
// _injectedOnce: false until first injection; reset to false after compaction.
// _dirty: set to true by tool.execute.after when a memory tool mutates MEMORY.md;
//         cleared after system.transform injects the updated content.
// _turnCount: incremented each turn; used to enforce the inject_every_n_turns interval.
let _injectedOnce = false;
let _dirty = false;
let _turnCount = 0;

function getCache(forceRefresh = false) {
  if (!_cache || forceRefresh) {
    const rules = readMemoryRules();
    const config = parseConfig(rules);
    const content = readMemoryIndex(config.maxLines);
    _cache = { rules, config, content };
  }
  return _cache;
}

function invalidateCache() {
  _cache = null;
}

// --- Config parsing ---

function parseConfig(rulesContent) {
  const config = { maxLines: MAX_LINES, staleAfterDays: DEFAULT_STALE_DAYS, injectEveryNTurns: DEFAULT_INJECT_INTERVAL };
  if (!rulesContent) return config;

  const maxMatch = rulesContent.match(/^\s*max_lines:\s*(\d+)\s*$/m);
  if (maxMatch) {
    const val = parseInt(maxMatch[1], 10);
    config.maxLines = Math.min(500, Math.max(50, val));
  }

  const staleMatch = rulesContent.match(/^\s*stale_after_days:\s*(\d+)\s*$/m);
  if (staleMatch) {
    config.staleAfterDays = Math.max(0, parseInt(staleMatch[1], 10));
  }

  const injectMatch = rulesContent.match(/^\s*inject_every_n_turns:\s*(\d+)\s*$/m);
  if (injectMatch) {
    config.injectEveryNTurns = Math.max(1, parseInt(injectMatch[1], 10));
  }

  return config;
}

// --- File I/O helpers ---

function ensureMemoryDir() {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

function readMemoryRules() {
  try {
    if (!fs.existsSync(MEMORY_RULES)) {
      ensureMemoryDir();
      fs.writeFileSync(MEMORY_RULES, INITIAL_RULES, 'utf8');
      return INITIAL_RULES;
    }
    return fs.readFileSync(MEMORY_RULES, 'utf8');
  } catch {
    return null;
  }
}

function readMemoryIndex(maxLines) {
  try {
    if (!fs.existsSync(MEMORY_INDEX)) {
      ensureMemoryDir();
      fs.writeFileSync(MEMORY_INDEX, INITIAL_MEMORY, 'utf8');
      return INITIAL_MEMORY;
    }
    const raw = fs.readFileSync(MEMORY_INDEX, 'utf8');
    const lines = raw.split('\n');
    if (lines.length > maxLines || Buffer.byteLength(raw) > MAX_BYTES) {
      const truncated = lines.slice(0, maxLines).join('\n');
      return truncated + `\n\n<!-- memory truncated: MEMORY.md exceeds ${maxLines}-line limit; shorten the index -->`;
    }
    return raw;
  } catch {
    return null;
  }
}

// --- Index line parsing ---

// Parses a single index line into parts. Returns null if not a memory entry line.
// Line format: - [Topic Name](file.md) [pin] YYYY-MM-DD [stale?] -- summary
function parseIndexLine(line) {
  const match = line.match(/^(\s*-\s+\[)([^\]]+)(\]\()([^)]+)(\))(.*)/);
  if (!match) return null;
  return {
    prefix: match[1],      // "- ["
    name: match[2],         // "Topic Name"
    mid: match[3] + match[4] + match[5], // "](file.md)"
    filename: match[4],     // "file.md"
    rest: match[6],         // " [pin] YYYY-MM-DD [stale?] -- summary"
  };
}

function today() {
  return new Date().toISOString().slice(0, 10);
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

function maintainIndex(lines, config) {
  const { staleAfterDays } = config;
  const seen = new Map(); // filename -> index in lines array (for duplicate detection)
  const result = [];

  for (const line of lines) {
    const parsed = parseIndexLine(line);
    if (!parsed) {
      result.push(line);
      continue;
    }

    const { filename, prefix, mid } = parsed;
    let rest = parsed.rest;

    // Orphan check
    const fullPath = path.join(MEMORY_DIR, filename);
    if (!fs.existsSync(fullPath)) {
      // Remove this line entirely
      continue;
    }

    // Duplicate check: keep the one with the more recent date
    if (seen.has(filename)) {
      const existingIdx = seen.get(filename);
      const existingLine = result[existingIdx];
      const existingDate = (existingLine.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
      const thisDate = (rest.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
      if (thisDate > existingDate) {
        // Replace the existing one with this one
        result[existingIdx] = null; // mark for removal
        seen.set(filename, result.length);
      } else {
        // Drop this line
        continue;
      }
    } else {
      seen.set(filename, result.length);
    }

    // [stale?] stamping — skip pinned entries
    const isPinned = rest.includes('[pin]');
    if (!isPinned && staleAfterDays > 0) {
      const dateMatch = rest.match(/(\d{4}-\d{2}-\d{2})/);
      if (dateMatch) {
        const age = daysSince(dateMatch[1]);
        if (age !== null && age > staleAfterDays) {
          // Stamp [stale?] after the date if not already present
          if (!rest.includes('[stale?]')) {
            rest = rest.replace(dateMatch[1], dateMatch[1] + ' [stale?]');
          }
        } else {
          // Remove [stale?] if present (self-heal)
          rest = rest.replace(' [stale?]', '');
        }
      }
    }

    result.push(prefix + parsed.name + mid + rest);
  }

  // Remove nulls from duplicate elimination
  return result.filter(l => l !== null);
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
  const dateStr = today();

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

// Simple in-process mutex to prevent concurrent index writes
let writeLock = false;
async function withLock(fn) {
  while (writeLock) {
    await new Promise(r => setTimeout(r, 10));
  }
  writeLock = true;
  try {
    return await fn();
  } finally {
    writeLock = false;
  }
}

// --- Tool definitions ---

const tools = {
  write_memory: {
    description: 'Write or update a memory topic. Creates a new topic file or appends to an existing one. Updates the MEMORY.md index automatically. Use this instead of raw Write/Edit tools for all memory operations.',
    args: {
      topic: z.string().describe('Topic name, e.g. "PostgreSQL Setup" or "Homelab Server"'),
      content: z.string().describe('The content to write or append to the topic file'),
      summary: z.string().describe('One-line summary for the MEMORY.md index entry'),
      pin: z.boolean().default(false).describe('Pin this entry so it is never a cleanup candidate'),
    },
    async execute(args) {
      return withLock(() => {
        const { topic, content, summary, pin } = args;

        ensureMemoryDir();

        // Read index once — reuse for topic-name lookup and upsert
        const rawIndex = fs.existsSync(MEMORY_INDEX)
          ? fs.readFileSync(MEMORY_INDEX, 'utf8')
          : INITIAL_MEMORY;

        // Check if an existing index entry matches this topic name — use its filename if so
        let filename = toSlug(topic) + '.md';
        for (const line of rawIndex.split('\n')) {
          const parsed = parseIndexLine(line);
          if (parsed && parsed.name.toLowerCase() === topic.toLowerCase()) {
            filename = parsed.filename;
            break;
          }
        }
        const topicPath = path.join(MEMORY_DIR, filename);

        let isNew = false;
        if (!fs.existsSync(topicPath)) {
          isNew = true;
          const frontmatter = `---\nname: ${topic}\ndescription: ${summary}\ncreated: ${today()}\nmetadata:\n  node_type: memory\n---\n\n`;
          fs.writeFileSync(topicPath, frontmatter + content + '\n', 'utf8');
        } else {
          const heading = `\n## ${today()}\n\n`;
          fs.appendFileSync(topicPath, heading + content + '\n', 'utf8');
        }

        // Update index
        let lines = rawIndex.split('\n');

        lines = upsertIndexLine(lines, filename, topic, summary, pin);

        const { config } = getCache();
        lines = maintainIndex(lines, config);

        fs.writeFileSync(MEMORY_INDEX, lines.join('\n'), 'utf8');
        invalidateCache();

        return `Memory ${isNew ? 'created' : 'updated'}: ${topicPath}\nIndex updated: ${MEMORY_INDEX}\nEntry: [${topic}](${filename}) ${today()} -- ${summary}`;
      });
    },
  },

  remove_memory: {
    description: 'Remove a topic entry from the MEMORY.md index. The topic file on disk is preserved. Pinned entries cannot be removed.',
    args: {
      topic: z.string().describe('Topic name or partial filename to search for (case-insensitive)'),
    },
    async execute(args) {
      return withLock(() => {
        const { topic } = args;
        const search = topic.toLowerCase();

        if (!fs.existsSync(MEMORY_INDEX)) {
          return 'No memory index found.';
        }

        const raw = fs.readFileSync(MEMORY_INDEX, 'utf8');
        const lines = raw.split('\n');

        const found = findIndexEntry(lines, search);
        if (!found) {
          return `No matching entry found for "${topic}".`;
        }
        const { idx: foundIdx, parsed } = found;

        if (parsed.rest.includes('[pin]')) {
          return `Entry is pinned and cannot be removed. Use pin_memory with pin: false to unpin it first.`;
        }

        const removedLine = lines[foundIdx];
        lines.splice(foundIdx, 1);

        const { config } = getCache();
        const maintained = maintainIndex(lines, config);

        fs.writeFileSync(MEMORY_INDEX, maintained.join('\n'), 'utf8');
        invalidateCache();

        const topicFile = path.join(MEMORY_DIR, parsed.filename);
        const fileNote = fs.existsSync(topicFile)
          ? `Topic file ${parsed.filename} still exists on disk.`
          : `Topic file ${parsed.filename} was not found on disk.`;

        return `Index entry removed: ${removedLine.trim()}\n${fileNote}`;
      });
    },
  },

  pin_memory: {
    description: 'Pin or unpin a memory index entry. Pinned entries are never flagged as stale and cannot be removed.',
    args: {
      topic: z.string().describe('Topic name or partial filename to search for (case-insensitive)'),
      pin: z.boolean().describe('true to pin, false to unpin'),
    },
    async execute(args) {
      return withLock(() => {
        const { topic, pin } = args;
        const search = topic.toLowerCase();

        if (!fs.existsSync(MEMORY_INDEX)) {
          return 'No memory index found.';
        }

        const raw = fs.readFileSync(MEMORY_INDEX, 'utf8');
        const lines = raw.split('\n');

        const found = findIndexEntry(lines, search);
        if (!found) {
          return `No matching entry found for "${topic}".`;
        }
        const { idx: foundIdx, parsed } = found;

        const line = lines[foundIdx];
        const alreadyPinned = parsed.rest.includes('[pin]');

        if (pin && alreadyPinned) return `Already pinned: ${line.trim()}`;
        if (!pin && !alreadyPinned) return `Already unpinned: ${line.trim()}`;

        const newRest = pin
          ? ' [pin]' + parsed.rest
          : parsed.rest.replace(/\s*\[pin\]/, '');

        const before = line.trim();
        lines[foundIdx] = parsed.prefix + parsed.name + parsed.mid + newRest;
        const after = lines[foundIdx].trim();

        const { config } = getCache();
        const maintained = maintainIndex(lines, config);

        fs.writeFileSync(MEMORY_INDEX, maintained.join('\n'), 'utf8');
        invalidateCache();

        return `${pin ? 'Pinned' : 'Unpinned'}.\nBefore: ${before}\nAfter:  ${after}`;
      });
    },
  },
};

// --- Plugin export ---

export default async ({ client } = {}) => {
  const skillsDir = new URL('../../skills', import.meta.url).pathname;

  return {
    config: async (config) => {
      // Register skills directory
      config.skills = config.skills || {};
      config.skills.paths = config.skills.paths || [];
      if (!config.skills.paths.includes(skillsDir)) {
        config.skills.paths.push(skillsDir);
      }

      // Register /memory command
      if (!config.command) config.command = {};
      config.command['memory'] = {
        description: '/memory → show index | /memory <text> → store | /memory pin <topic> → pin | /memory unpin <topic> → unpin | /memory remove <topic> → remove entry',
        template: `Memory dir: ${MEMORY_DIR}
Memory index: ${MEMORY_INDEX}

Arguments: $ARGUMENTS

## No arguments: show index

Read ${MEMORY_INDEX}. Display each entry as a table with columns: Topic (name only — no markdown links, no filenames), Date, Pinned (yes/no), Stale (yes/no). List all .md files in ${MEMORY_DIR}. Do not write anything.

After listing, append this legend:
Tip: /memory <text> to store  |  /memory pin <topic> to pin  |  /memory unpin <topic> to unpin  |  /memory remove <topic> to remove

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

## Arguments provided (not starting with "pin ", "unpin ", or "remove "): store a memory

Treat the arguments as a fact or note to persist. Decide the topic, a slug filename, a one-line summary, and whether the topic is permanent (hardware, user identity, core workflows = pin it). Then call the write_memory tool:
  write_memory({ topic: "<topic name>", content: "<the full fact or note>", summary: "<one-line summary>", pin: <true|false> })

The tool creates a new topic file or appends to an existing one, and updates the MEMORY.md index automatically.

Any text including single words is treated literally as content to store. Do not interpret "show", "list", or similar words as subcommands unless the full argument starts with "pin ", "unpin ", or "remove ".`,
      };
    },

    tool: tools,

    // Set _dirty when a memory tool mutates MEMORY.md so system.transform
    // knows to re-inject the updated index on the next turn.
    'tool.execute.after': async (input, _output) => {
      const memoryTools = new Set(['write_memory', 'remove_memory', 'pin_memory']);
      if (memoryTools.has(input.tool)) {
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
      const { rules, content, config } = getCache();
      const shouldInject = !_injectedOnce || _dirty || (_turnCount % config.injectEveryNTurns === 0);

      if (shouldInject) {
        if (content) {
          output.system.push(`## Global Memory\n\nThe following is your persistent memory index. It persists across all sessions. Topic files referenced here can be read on-demand for detail.\n\nMemory dir: ${MEMORY_DIR}\n\n${content}`);
        }

        if (rules) {
          output.system.push(`## Memory Rules\n\nThe following rules govern what to persist or avoid persisting to memory. Edit ${MEMORY_RULES} to customise.\n\n${rules}`);
        }

        _injectedOnce = true;
        _dirty = false;
      }
    },

    'experimental.session.compacting': async (_input, output) => {
      // Force a fresh read so the compaction prompt gets up-to-date memory state.
      const { rules, content } = getCache(true);

      if (content) {
        output.context.push(`## Global Memory (current index)\n\n${content}`);
      }

      if (rules) {
        output.context.push(`## Memory Rules\n\n${rules}`);
      }

      // Reset so the first turn after compaction re-injects memory into the
      // system prompt — the agent's context window was just replaced.
      _injectedOnce = false;
      _dirty = false;
      _turnCount = 0;
    },
  };
};
