import fs from 'fs';
import os from 'os';
import path from 'path';

const MEMORY_DIR = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'opencode', 'memory'
);
const MEMORY_INDEX = path.join(MEMORY_DIR, 'MEMORY.md');
const DIRTY_SENTINEL = path.join(MEMORY_DIR, '.invalidate');

// Parse MEMORY.md into structured entries.
// Line format: - [Name](file.md) [pin] YYYY-MM-DDTHH:MM:SS±HH:MM [stale?] -- summary
function parseIndex() {
  if (!fs.existsSync(MEMORY_INDEX)) return [];
  const entries = [];
  for (const line of fs.readFileSync(MEMORY_INDEX, 'utf8').split('\n')) {
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

// Toggle [pin] on the index line matched by filename.
function setPin(filename, pin) {
  const lines = fs.readFileSync(MEMORY_INDEX, 'utf8').split('\n');
  const updated = lines.map(line => {
    if (!line.includes(`](${filename})`)) return line;
    if (pin)  return line.includes('[pin]') ? line : line.replace(/(\]\([^)]+\))/, '$1 [pin]');
    if (!pin) return line.replace(/\s*\[pin\]/, '');
    return line;
  });
  fs.writeFileSync(MEMORY_INDEX, updated.join('\n'), 'utf8');
  try { fs.writeFileSync(DIRTY_SENTINEL, '', 'utf8'); } catch {}
}

// Remove the index line matched by filename (topic file on disk is preserved).
function removeEntry(filename) {
  const lines = fs.readFileSync(MEMORY_INDEX, 'utf8').split('\n');
  fs.writeFileSync(MEMORY_INDEX, lines.filter(l => !l.includes(`](${filename})`)).join('\n'), 'utf8');
  try { fs.writeFileSync(DIRTY_SENTINEL, '', 'utf8'); } catch {}
}

// Read topic file: strip YAML frontmatter, return first 10 lines of body content.
function readTopic(filename) {
  const p = path.join(MEMORY_DIR, filename);
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
  function showBrowser() {
    const entries = parseIndex();
    api.ui.dialog.setSize('large');
    api.ui.dialog.replace(() => api.ui.DialogSelect({
      title:       `Memory (${entries.length} ${entries.length === 1 ? 'entry' : 'entries'})`,
      placeholder: 'Filter by topic...',
      options:     entries.map(e => ({
        title:       `${e.name}${e.pinned ? ' [pin]' : ''}${e.stale ? ' [stale?]' : ''}`,
        description: [e.summary, e.date].filter(Boolean).join('  '),
        value:       e,
      })),
      onSelect: opt => showActions(opt.value),
    }));
  }

  function showActions(entry) {
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
              message:   readTopic(entry.filename),
              onConfirm: () => setTimeout(() => showActions(entry), 0),
            }));
            break;
          case 'pin':
            setPin(entry.filename, true);
            showBrowser();
            break;
          case 'unpin':
            setPin(entry.filename, false);
            showBrowser();
            break;
          case 'remove':
            api.ui.dialog.replace(() => api.ui.DialogConfirm({
              title:     'Remove from index',
              message:   `Remove "${entry.name}" from the memory index?\n\nThe topic file is preserved on disk.`,
              onConfirm: () => { removeEntry(entry.filename); showBrowser(); },
              onCancel:  () => showActions(entry),
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

export default { id: 'ocl-memory-tui', tui };
