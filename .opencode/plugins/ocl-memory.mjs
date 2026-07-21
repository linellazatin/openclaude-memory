import fs from 'fs';
import os from 'os';
import path from 'path';

const MEMORY_DIR = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'opencode', 'memory'
);
const MEMORY_INDEX = path.join(MEMORY_DIR, 'MEMORY.md');
const MEMORY_RULES = path.join(MEMORY_DIR, 'RULES.md');

const MAX_LINES = 200;
const MAX_BYTES = 25 * 1024;

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
# max_lines: 200  (default; valid range 50–500)
`;

function parseMaxLines(rulesContent) {
  if (!rulesContent) return MAX_LINES;
  const match = rulesContent.match(/^\s*max_lines:\s*(\d+)\s*$/m);
  if (!match) return MAX_LINES;
  const val = parseInt(match[1], 10);
  if (val < 50) return 50;
  if (val > 500) return 500;
  return val;
}

function readMemoryIndex(maxLines) {
  try {
    if (!fs.existsSync(MEMORY_INDEX)) {
      fs.mkdirSync(MEMORY_DIR, { recursive: true });
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

function readMemoryRules() {
  try {
    if (!fs.existsSync(MEMORY_RULES)) {
      fs.mkdirSync(MEMORY_DIR, { recursive: true });
      fs.writeFileSync(MEMORY_RULES, INITIAL_RULES, 'utf8');
      return INITIAL_RULES;
    }
    return fs.readFileSync(MEMORY_RULES, 'utf8');
  } catch {
    return null;
  }
}

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
        description: '/memory → show index | /memory <text> → store | /memory pin <topic> → pin | /memory remove <topic> → remove entry',
        template: `Memory dir: ${MEMORY_DIR}
Memory index: ${MEMORY_INDEX}

Arguments: $ARGUMENTS

## No arguments: show index

Read and display ${MEMORY_INDEX}. For each entry, show whether it is pinned ([pin]) or not. List all .md files in ${MEMORY_DIR}. Do not write anything.

After listing, append this legend:
Tip: /memory <text> to store  |  /memory pin <topic> to pin  |  /memory remove <topic> to remove

## Arguments start with "remove ": remove an index entry

The text after "remove " is the topic to find. Steps:
1. Read ${MEMORY_INDEX}.
2. Find the index line whose topic name or filename contains the search text (case-insensitive).
3. If no match found: report "no matching entry found" and stop.
4. If the entry has [pin]: refuse removal and report "entry is pinned; unpin it first by editing MEMORY.md directly". Stop.
5. Remove that line from ${MEMORY_INDEX}. Do not delete the topic file.
6. Check if a topic file for this entry exists in ${MEMORY_DIR}. If it does, note it in the confirmation: "Index entry removed. Topic file <filename> still exists on disk."
7. Confirm: which entry was removed.

## Arguments start with "pin ": pin an entry

The text after "pin " is the topic to find. Steps:
1. Read ${MEMORY_INDEX}.
2. Find the index line whose topic name or filename contains the search text (case-insensitive).
3. If no match found: report "no matching entry found" and stop.
4. If already pinned: report "already pinned" and stop.
5. Insert [pin] immediately after the closing ] of the filename link, before any date or --. Do not change any other part of the line.
   Examples:
   Before: - [Homelab Server](homelab-server.md) 2026-07-20 -- Intel i5...
   After:  - [Homelab Server](homelab-server.md) [pin] 2026-07-20 -- Intel i5...

   Before: - [Some Topic](some-topic.md) -- summary text
   After:  - [Some Topic](some-topic.md) [pin] 2026-07-21 -- summary text
6. Write the updated line back to ${MEMORY_INDEX}.
7. Confirm: which entry was pinned.

## Arguments provided (not starting with "pin " or "remove "): store a memory

Treat arguments as a fact or note to persist. Steps:
1. Decide whether it belongs in an existing topic file or warrants a new one.
2. Write to the appropriate topic file in ${MEMORY_DIR}.
3. Update the index entry in ${MEMORY_INDEX}. Set last_updated to today's date (YYYY-MM-DD). Preserve [pin] if present. Preserve the -- summary. Do not change any other part of the line.
   Examples of the index entry update:
   Before: - [Topic](file.md) -- summary
   After:  - [Topic](file.md) 2026-07-21 -- summary

   Before: - [Topic](file.md) [pin] 2026-06-01 -- summary
   After:  - [Topic](file.md) [pin] 2026-07-21 -- summary

   Full format for a new entry: - [Name](file.md) [pin] YYYY-MM-DD -- summary  (omit [pin] if not permanent)
4. If a new topic file was created, add a new index line with today's date. Add [pin] if the topic is clearly permanent (hardware, user identity, core workflows).
5. Confirm: what was stored, which file, whether MEMORY.md was updated.

Any text including single words is treated literally as content to store. Do not interpret "show", "list", or similar words as subcommands unless the full argument starts with "pin " or "remove ".`
      };
    },

    'experimental.chat.system.transform': async (_input, output) => {
      const rules = readMemoryRules();
      const maxLines = parseMaxLines(rules);
      const content = readMemoryIndex(maxLines);

      if (content) {
        output.system.push(`## Global Memory\n\nThe following is your persistent memory index. It persists across all sessions. Topic files referenced here can be read on-demand for detail.\n\nMemory dir: ${MEMORY_DIR}\n\n${content}`);
      }

      if (rules) {
        output.system.push(`## Memory Rules\n\nThe following rules govern what to persist or avoid persisting to memory. Edit ${MEMORY_RULES} to customise.\n\n${rules}`);
      }
    },
  };
};
