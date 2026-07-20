import fs from 'fs';
import os from 'os';
import path from 'path';

const MEMORY_DIR = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'opencode', 'memory'
);
const MEMORY_INDEX = path.join(MEMORY_DIR, 'MEMORY.md');

const MAX_LINES = 200;
const MAX_BYTES = 25 * 1024;

const INITIAL_MEMORY = `# Memory Index

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
        template: `Global memory dir: ${MEMORY_DIR}\n\nNo arguments: read and display ${MEMORY_INDEX} and list all topic files. Do not write anything.\n\nWith arguments ($ARGUMENTS): treat as a fact to persist — write to the appropriate topic file in ${MEMORY_DIR}, update ${MEMORY_INDEX} if needed, confirm what was stored and where. Treat any text including single words literally as content to store.`
      };
    },

    'experimental.chat.system.transform': async (_input, output) => {
      const content = readMemoryIndex();
      if (!content) return;
      output.system.push(`## Global Memory\n\nThe following is your persistent memory index. It persists across all sessions. Topic files referenced here can be read on-demand for detail.\n\nMemory dir: ${MEMORY_DIR}\n\n${content}`);
    },
  };
};
