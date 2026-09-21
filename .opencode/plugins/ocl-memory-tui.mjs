import fs from 'fs';
import path from 'path';
import {
  readMemoryRules, parseRules, getMemoryDir, getMemoryIndex, getDirtySentinel, isSafeFilename,
  atomicWriteFileSync, withLock, LockContendedError, maybeCarryOverToSharedDir,
  addToRemovedList, parseIndexLine,
} from './ocl-memory-shared.mjs';

// Resolves which directory (local or shared, per memory.jsonc's shared_dir)
// is currently active. Called once per browser session (each ctrl+alt+m
// press) — cheap, low-frequency, so no caching is needed here (unlike the
// server plugin, which re-reads far more often). sharedDir is returned so
// mutations know whether to fail-closed on lock contention.
async function resolveActiveDir() {
  const config = parseRules(readMemoryRules());
  await maybeCarryOverToSharedDir(config);
  return { memDir: getMemoryDir(config), memIndex: getMemoryIndex(config), sharedDir: !!config.sharedDir };
}

// Parse MEMORY.md into structured entries.
// Line format: - [Name](file.md) [pin] YYYY-MM-DDTHH:MM:SS±HH:MM [stale?] -- summary
function parseIndex(memIndex) {
  if (!fs.existsSync(memIndex)) return [];
  const entries = [];
  for (const line of fs.readFileSync(memIndex, 'utf8').split('\n')) {
    const m = line.match(/^- \[([^\]]+)\]\(([^)]+)\)(.*)/);
    if (!m) continue;
    if (!isSafeFilename(m[2])) continue;
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

// Toggle [pin] on the index line whose PARSED filename equals `filename`.
// Parse-based (not `line.includes('](file)')`) so a foreign line that merely
// MENTIONS `](file.md)` in its summary text is never pinned by accident.
// Locked + atomic, same pattern as the server tools — and, like them, fails
// closed on contention whenever shared_dir is active (strict) so a co-tenant's
// in-flight index update is never clobbered.
async function setPin(memDir, memIndex, filename, pin, sharedDir) {
  if (!isSafeFilename(filename)) return '(unsafe filename refused)';
  if (!fs.existsSync(memIndex)) return 'No memory index found.';
  try {
    return await withLock(memDir, async () => {
      const lines = fs.readFileSync(memIndex, 'utf8').split('\n');
      const updated = lines.map(line => {
        const parsed = parseIndexLine(line);
        if (!parsed || parsed.filename !== filename) return line;
        if (pin)  return parsed.rest.includes('[pin]') ? line : line.replace(/(\]\([^)]+\))/, '$1 [pin]');
        return line.replace(/\s*\[pin\]/, '');
      });
      atomicWriteFileSync(memIndex, updated.join('\n'));
      try { fs.writeFileSync(getDirtySentinel(memDir), '', 'utf8'); } catch {}
    }, { strict: sharedDir });
  } catch (e) {
    if (e instanceof LockContendedError) return 'Memory store is busy (another tool/process holds the lock) — retry in a moment.';
    throw e;
  }
}

// Remove the index line whose PARSED filename equals `filename` (topic file
// on disk is preserved). Parse-based so a line merely MENTIONING the link in
// its summary text is never dropped.
async function removeEntry(memDir, memIndex, filename, sharedDir) {
  if (!isSafeFilename(filename)) return '(unsafe filename refused)';
  if (!fs.existsSync(memIndex)) return 'No memory index found.';
  try {
    return await withLock(memDir, async () => {
      const lines = fs.readFileSync(memIndex, 'utf8').split('\n');
      atomicWriteFileSync(memIndex, lines.filter(l => {
        const parsed = parseIndexLine(l);
        return !(parsed && parsed.filename === filename);
      }).join('\n'));
      addToRemovedList(memDir, filename); // tombstone so server repair_memory won't resurrect it
      try { fs.writeFileSync(getDirtySentinel(memDir), '', 'utf8'); } catch {}
    }, { strict: sharedDir });
  } catch (e) {
    if (e instanceof LockContendedError) return 'Memory store is busy (another tool/process holds the lock) — retry in a moment.';
    throw e;
  }
}

// Read topic file: strip YAML frontmatter, return first 10 lines of body content.
function readTopic(memDir, filename) {
  if (!isSafeFilename(filename)) return '(unsafe filename refused)';
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
    const { memDir, memIndex, sharedDir } = await resolveActiveDir();
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
      onSelect: opt => showActions(opt.value, memDir, memIndex, sharedDir),
    }));
  }

  function showActions(entry, memDir, memIndex, sharedDir) {
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
              onConfirm: () => setTimeout(() => showActions(entry, memDir, memIndex, sharedDir), 0),
            }));
            break;
          case 'pin':
            setPin(memDir, memIndex, entry.filename, true, sharedDir).then(showBrowser);
            break;
          case 'unpin':
            setPin(memDir, memIndex, entry.filename, false, sharedDir).then(showBrowser);
            break;
          case 'remove':
            api.ui.dialog.replace(() => api.ui.DialogConfirm({
              title:     'Remove from index',
              message:   `Remove "${entry.name}" from the memory index?\n\nThe topic file is preserved on disk.`,
              onConfirm: () => { removeEntry(memDir, memIndex, entry.filename, sharedDir).then(showBrowser); },
              onCancel:  () => showActions(entry, memDir, memIndex, sharedDir),
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
