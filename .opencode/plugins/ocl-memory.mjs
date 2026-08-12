import fs from 'fs';
import os from 'os';
import path from 'path';

const MEMORY_DIR = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'opencode', 'memory'
);
const MEMORY_INDEX = path.join(MEMORY_DIR, 'MEMORY.md');
const MEMORY_RULES = path.join(MEMORY_DIR, 'RULES.jsonc');
const MEMORY_RULES_LEGACY = path.join(MEMORY_DIR, 'RULES.md');

const MAX_LINES = 200;
const MAX_BYTES = 25 * 1024;
const DEFAULT_STALE_DAYS = 180;
const DEFAULT_INJECT_INTERVAL = 5;

const INITIAL_MEMORY = `# Memory Index

`;

const INITIAL_RULES_JSONC = `{
  // What to always persist
  "always_persist": [
    "Any issue solved or fixed",
    "Server or infrastructure configuration discovered or changed",
    "Reusable commands or workflows identified",
    "Hardware, model, or environment facts learned"
  ],
  // What to never persist
  "never_persist": [
    "Code patterns, conventions, or architecture derivable from reading the codebase",
    "Git history — use git log/blame instead",
    "Debugging fix recipes — the fix is in the code; the commit message has the context",
    "Ephemeral in-session task state (todos, current work-in-progress)",
    "Anything already documented in AGENTS.md, CLAUDE.md, or project config files",
    "Large code blocks — summarize the insight or link to the file path instead"
  ],
  // Always ask before persisting (non-overridable)
  "always_ask": [
    "Credentials, tokens, API keys",
    "Personal data",
    "Anything the user marks as private or ephemeral"
  ],
  // max_lines: valid range 50–500
  "max_lines": 200,
  // stale_after_days: 0 = disable age flagging
  "stale_after_days": 180,
  // inject_every_n_turns: re-inject memory every N user prompts; 1 = every prompt
  "inject_every_n_turns": 5
}
`;

// --- In-process cache ---
// Loaded once per session (or after any tool mutation / compaction).
// Avoids re-reading RULES.jsonc and MEMORY.md on every turn.
// Caveat: manual edits to RULES.jsonc or MEMORY.md between turns are not
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

function getCache(forceRefresh = false) {
  if (!_cache || forceRefresh) {
    const rules = readMemoryRules();
    const config = parseRules(rules);
    const renderedRules = renderRulesForInjection(rules);
    const content = readMemoryIndex(config.maxLines);
    _cache = { renderedRules, config, content };
  }
  return _cache;
}

function invalidateCache() {
  _cache = null;
}

// --- Config parsing ---

const stripJsonc = raw => raw.replace(/\/\/[^\n]*/g, '').replace(/,\s*([}\]])/g, '$1');

function parseRules(raw) {
  const defaults = { maxLines: MAX_LINES, staleAfterDays: DEFAULT_STALE_DAYS, injectEveryNTurns: DEFAULT_INJECT_INTERVAL };
  if (!raw) return defaults;
  try {
    const obj = JSON.parse(stripJsonc(raw));
    return {
      maxLines: Math.min(500, Math.max(50, Number.isInteger(obj.max_lines) ? obj.max_lines : defaults.maxLines)),
      staleAfterDays: typeof obj.stale_after_days === 'number' ? Math.max(0, obj.stale_after_days) : defaults.staleAfterDays,
      injectEveryNTurns: Number.isInteger(obj.inject_every_n_turns) ? Math.max(1, obj.inject_every_n_turns) : defaults.injectEveryNTurns,
    };
  } catch {
    return defaults;
  }
}

// Transforms RULES.jsonc content into markdown for agent injection.
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

// --- File I/O helpers ---

function ensureMemoryDir() {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

// Converts legacy RULES.md content to a RULES.jsonc string.
// Extracts bullet lists from known sections and uncommented numeric config keys.
function migrateRulesMd(md) {
  const extractBullets = (sectionPattern) => {
    const m = md.match(new RegExp(`##\\s+${sectionPattern}[^\\n]*\\n([\\s\\S]*?)(?=\\n##|$)`, 'i'));
    if (!m) return [];
    return m[1].split('\n')
      .map(l => l.replace(/^\s*-\s*/, '').trim())
      .filter(l => l && !l.startsWith('#'));
  };

  const numKey = (key, def) => {
    const m = md.match(new RegExp(`^\\s*${key}:\\s*(\\d+)\\s*$`, 'm'));
    return m ? parseInt(m[1], 10) : def;
  };

  const arr = (items) => items.length
    ? '[\n' + items.map(i => `    ${JSON.stringify(i)}`).join(',\n') + '\n  ]'
    : '[]';

  const always = extractBullets('Always persist');
  const never = extractBullets('Never persist');
  const ask = extractBullets('Always ask');
  const maxLines = numKey('max_lines', 200);
  const stale = numKey('stale_after_days', 180);
  const inject = numKey('inject_every_n_turns', 5);

  return `{
  // What to always persist
  "always_persist": ${arr(always)},
  // What to never persist
  "never_persist": ${arr(never)},
  // Always ask before persisting (non-overridable)
  "always_ask": ${arr(ask)},
  // max_lines: valid range 50–500
  "max_lines": ${maxLines},
  // stale_after_days: 0 = disable age flagging
  "stale_after_days": ${stale},
  // inject_every_n_turns: re-inject memory every N user prompts; 1 = every prompt
  "inject_every_n_turns": ${inject}
}
`;
}

function readMemoryRules() {
  try {
    if (!fs.existsSync(MEMORY_RULES)) {
      ensureMemoryDir();
      if (fs.existsSync(MEMORY_RULES_LEGACY)) {
        const md = fs.readFileSync(MEMORY_RULES_LEGACY, 'utf8');
        const jsonc = migrateRulesMd(md);
        fs.writeFileSync(MEMORY_RULES, jsonc, 'utf8');
        fs.renameSync(MEMORY_RULES_LEGACY, MEMORY_RULES_LEGACY + '.bak');
        return jsonc;
      }
      fs.writeFileSync(MEMORY_RULES, INITIAL_RULES_JSONC, 'utf8');
      return INITIAL_RULES_JSONC;
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
      const dateMatch = rest.match(/(\d{4}-\d{2}-\d{2}(?:T[\d:.+-]+)?)/);
      if (dateMatch) {
        const age = daysSince(dateMatch[1]);
        if (age !== null && age > staleAfterDays) {
          // Stamp [stale?] after the date/datetime token if not already present
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
        const now = nowIso();
        const frontmatter = `---\nname: ${topic}\ndescription: ${summary}\ncreated: ${now}\nlast_updated: ${now}\nmetadata:\n  node_type: memory\n---\n\n`;
        fs.writeFileSync(topicPath, frontmatter + content + '\n', 'utf8');
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
        fs.writeFileSync(topicPath, fm + '\n' + content + '\n', 'utf8');
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
        fs.writeFileSync(topicPath, body + `\n## ${now}\n\n` + content + '\n', 'utf8');
      }

      // Update index
      let lines = rawIndex.split('\n');

      lines = upsertIndexLine(lines, filename, topic, summary, pin);

      const { config } = getCache(); // read config before invalidating
      lines = maintainIndex(lines, config);

      fs.writeFileSync(MEMORY_INDEX, lines.join('\n'), 'utf8');
      invalidateCache(); // nuke cache so the next caller re-reads the fresh index

      return `Memory ${isNew ? 'created' : 'updated'}: ${topicPath}\nIndex updated: ${MEMORY_INDEX}\nEntry: [${topic}](${filename}) ${nowIso()} -- ${summary}`;
    },
  },

  remove_memory: {
    description: 'Remove a topic entry from the MEMORY.md index. The topic file on disk is preserved. Pinned entries cannot be removed.',
    args: {
      topic: { type: 'string', description: 'Topic name or partial filename to search for (case-insensitive)' },
    },
    async execute(args) {
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
    },
  },
};

// --- Plugin export ---

export default async () => {
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
      const { renderedRules, content, config } = getCache();
      const shouldInject = !_injectedOnce || _dirty || (_turnCount % config.injectEveryNTurns === 0);

      if (shouldInject) {
        if (content) {
          output.system.push(`## Global Memory\n\nThe following is your persistent memory index. It persists across all sessions. Topic files referenced here can be read on-demand for detail.\n\nMemory dir: ${MEMORY_DIR}\n\n${content}`);
        }

        if (renderedRules) {
          output.system.push(`## Memory Rules\n\nThe following rules govern what to persist or avoid persisting to memory. Edit ${MEMORY_RULES} to customise.\n\n${renderedRules}`);
        }

        _injectedOnce = true;
        _dirty = false;
      }
    },

    'experimental.session.compacting': async (_input, output) => {
      // Force a fresh read so the compaction prompt gets up-to-date memory state.
      const { renderedRules, content } = getCache(true);

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
  };
};
