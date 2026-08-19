import fs from 'fs';
import path from 'path';
import {
  readMemoryRules, parseRules, getMemoryDir, getMemoryIndex, getDirtySentinel,
  atomicWriteFileSync, acquireLock, releaseLock, maybeCarryOverToSharedDir,
} from './ocl-memory-shared.mjs';

// Resolves which directory (local or shared, per memory.jsonc's shared_dir)
// is currently active. Called once per browser session (each ctrl+alt+m
// press) — cheap, low-frequency, so no caching is needed here (unlike the
// server plugin, which re-reads far more often).
async function resolveActiveDir() {
  const config = parseRules(readMemoryRules());
  await maybeCarryOverToSharedDir(config);
  return { memDir: getMemoryDir(config), memIndex: getMemoryIndex(config) };
}

// Parse MEMORY.md into structured entries.
// Line format: - [Name](file.md) [pin] YYYY-MM-DDTHH:MM:SS±HH:MM [stale?] -- summary
function parseIndex(memIndex) {
  if (!fs.existsSync(memIndex)) return [];
  const entries = [];
  for (const line of fs.readFileSync(memIndex, 'utf8').split('\n')) {
    const m = line.match(/^- \[([^\]]+)\]\(([^)]+)\)(.*)/);
    if (!m) continue;
    const rest = m[3];
    const dateMatch = rest.match(/(\d{4}-\d{2}-\d{2}T[\d:+\-Z]+)/);
    const summaryMatch = rest.match(/--\s*(.+)$/);
    entries.push({
      name:     m[1],
      filename: m[2],
      pinned:   rest.includes('[pin]'),
      stale:    rest.includes('[stale?]'),
      date:     dateMatch    ? dateMatch[1].slice(0, 10) : '',
      summary:  summaryMatch ? summaryMatch[1].trim()   : '',
    });
  }
  return entries;
}

// Toggle [pin] on the index line matched by filename. Locked + atomic, same
// pattern as the server plugin's tools — matters once shared_dir puts other
// processes/tools in the same directory.
async function setPin(memDir, memIndex, filename, pin) {
  const lockPath = await acquireLock(memDir);
  try {
    const lines = fs.readFileSync(memIndex, 'utf8').split('\n');
    const updated = lines.map(line => {
      if (!line.includes(`](${filename})`)) return line;
      if (pin)  return line.includes('[pin]') ? line : line.replace(/(\]\([^)]+\))/, '$1 [pin]');
      if (!pin) return line.replace(/\s*\[pin\]/, '');
      return line;
    });
    atomicWriteFileSync(memIndex, updated.join('\n'));
    try { fs.writeFileSync(getDirtySentinel(memDir), '', 'utf8'); } catch {}
  } finally {
    releaseLock(lockPath);
  }
}

// Remove the index line matched by filename (topic file on disk is preserved).
async function removeEntry(memDir, memIndex, filename) {
  const lockPath = await acquireLock(memDir);
  try {
    const lines = fs.readFileSync(memIndex, 'utf8').split('\n');
    atomicWriteFileSync(memIndex, lines.filter(l => !l.includes(`](${filename})`)).join('\n'));
    try { fs.writeFileSync(getDirtySentinel(memDir), '', 'utf8'); } catch {}
  } finally {
    releaseLock(lockPath);
  }
}

// Read topic file: strip YAML frontmatter, return first 10 lines of body content.
function readTopic(memDir, filename) {
  const p = path.join(memDir, filename);
  if (!fs.existsSync(p)) return '(topic file not found on disk)';
  let body = fs.readFileSync(p, 'utf8');

  // Strip YAML frontmatter (--- ... ---)
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3);
    if (end !== -1) body = body.slice(end + 4).trimStart();
  }

  const lines = body.split('\n');
  const PREVIEW = 10;
  if (lines.length <= PREVIEW) return body.trimEnd();
  return lines.slice(0, PREVIEW).join('\n') + `\n\n(+ ${lines.length - PREVIEW} more lines)`;
}

const tui = async (api) => {
  async function showBrowser() {
    const { memDir, memIndex } = await resolveActiveDir();
    const entries = parseIndex(memIndex);
    api.ui.dialog.setSize('large');
    api.ui.dialog.replace(() => api.ui.DialogSelect({
      title:       `Memory (${entries.length} ${entries.length === 1 ? 'entry' : 'entries'})`,
      placeholder: 'Filter by topic...',
      options:     entries.map(e => ({
        title:       `${e.name}${e.pinned ? ' [pin]' : ''}${e.stale ? ' [stale?]' : ''}`,
        description: [e.summary, e.date].filter(Boolean).join('  '),
        value:       e,
      })),
      onSelect: opt => showActions(opt.value, memDir, memIndex),
    }));
  }

  function showActions(entry, memDir, memIndex) {
    api.ui.dialog.replace(() => api.ui.DialogSelect({
      title:      entry.name,
      skipFilter: true,
      options: [
        {
          title:       'View content',
          value:       'view',
          description: `Read ${entry.filename}`,
        },
        entry.pinned
          ? { title: 'Unpin',  value: 'unpin',  description: 'Remove [pin] flag from index' }
          : { title: 'Pin',    value: 'pin',    description: 'Add [pin] flag to index'     },
        {
          title:       'Remove from index',
          value:       'remove',
          description: 'Removes index entry; topic file preserved on disk',
        },
        {
          title:       'Back',
          value:       'back',
          description: 'Return to memory list',
        },
      ],
      onSelect: opt => {
        switch (opt.value) {
          case 'view':
            api.ui.dialog.replace(() => api.ui.DialogAlert({
              title:     entry.name,
              message:   readTopic(memDir, entry.filename),
              onConfirm: () => setTimeout(() => showActions(entry, memDir, memIndex), 0),
            }));
            break;
          case 'pin':
            setPin(memDir, memIndex, entry.filename, true).then(showBrowser);
            break;
          case 'unpin':
            setPin(memDir, memIndex, entry.filename, false).then(showBrowser);
            break;
          case 'remove':
            api.ui.dialog.replace(() => api.ui.DialogConfirm({
              title:     'Remove from index',
              message:   `Remove "${entry.name}" from the memory index?\n\nThe topic file is preserved on disk.`,
              onConfirm: () => { removeEntry(memDir, memIndex, entry.filename).then(showBrowser); },
              onCancel:  () => showActions(entry, memDir, memIndex),
            }));
            break;
          case 'back':
            showBrowser();
            break;
        }
      },
    }));
  }

  const disposeLayer = api.keymap.registerLayer({
    commands: [{
      name:        'ocl-memory.browser',
      title:       'Memory Browser',
      description: 'Browse and manage the memory index',
      category:    'Memory',
      run:         showBrowser,
    }],
    bindings: [
      { key: 'ctrl+alt+m', cmd: 'ocl-memory.browser' },
    ],
  });

  api.lifecycle.onDispose(disposeLayer);
};

export { parseIndex, setPin, removeEntry, readTopic, resolveActiveDir };
export default { id: 'ocl-memory-tui', tui };
