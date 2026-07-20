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
`;

function readMemoryIndex() {
  try {
    if (!fs.existsSync(MEMORY_INDEX)) {
      fs.mkdirSync(MEMORY_DIR, { recursive: true });
      fs.writeFileSync(MEMORY_INDEX, INITIAL_MEMORY, 'utf8');
      return INITIAL_MEMORY;
    }
    const raw = fs.readFileSync(MEMORY_INDEX, 'utf8');
    const lines = raw.split('\n');
    if (lines.length > MAX_LINES || Buffer.byteLength(raw) > MAX_BYTES) {
      const truncated = lines.slice(0, MAX_LINES).join('\n');
      return truncated + '\n\n<!-- memory truncated: MEMORY.md exceeds 200-line limit; shorten the index -->';
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
        description: '/memory → show index | /memory <text> → store a memory',
        template: `Memory dir: ${MEMORY_DIR}\n\nArguments: $ARGUMENTS\n\nIf arguments are empty: read and display ${MEMORY_INDEX} and list all .md files in the directory with their one-line summaries. Do not write anything.\n\nIf arguments are provided: treat them as a fact to persist — write to the appropriate topic file in ${MEMORY_DIR}, update ${MEMORY_INDEX} if needed, confirm what was stored and where. Any text including single words is treated literally as content to store.`
      };
    },

    'experimental.chat.system.transform': async (_input, output) => {
      const content = readMemoryIndex();
      if (content) {
        output.system.push(`## Global Memory\n\nThe following is your persistent memory index. It persists across all sessions. Topic files referenced here can be read on-demand for detail.\n\nMemory dir: ${MEMORY_DIR}\n\n${content}`);
      }

      const rules = readMemoryRules();
      if (rules) {
        output.system.push(`## Memory Rules\n\nThe following rules govern what to persist or avoid persisting to memory. Edit ${MEMORY_RULES} to customise.\n\n${rules}`);
      }
    },
  };
};
