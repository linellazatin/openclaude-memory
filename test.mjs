import assert from 'assert/strict';

// Pure functions inlined from ocl-memory.mjs for zero-dep testing.
// ponytail: inline copies — update here if the plugin functions change.

function parseIndexLine(line) {
  const match = line.match(/^(\s*-\s+\[)([^\]]+)(\]\()([^)]+)(\))(.*)/);
  if (!match) return null;
  return { prefix: match[1], name: match[2], mid: match[3]+match[4]+match[5], filename: match[4], rest: match[6] };
}

function toSlug(topic) {
  return topic.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-');
}

function parseConfig(rulesContent) {
  const config = { maxLines: 200, staleAfterDays: 180 };
  if (!rulesContent) return config;
  const maxMatch = rulesContent.match(/^\s*max_lines:\s*(\d+)\s*$/m);
  if (maxMatch) { const v = parseInt(maxMatch[1], 10); config.maxLines = Math.min(500, Math.max(50, v)); }
  const staleMatch = rulesContent.match(/^\s*stale_after_days:\s*(\d+)\s*$/m);
  if (staleMatch) { config.staleAfterDays = Math.max(0, parseInt(staleMatch[1], 10)); }
  return config;
}

function daysSince(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

function today() { return new Date().toISOString().slice(0, 10); }

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
  const pinToken = pin ? ' [pin]' : '';
  lines.push(`- [${name}](${filename})${pinToken} ${dateStr} -- ${summary}`);
  return lines;
}

// --- parseIndexLine ---

assert.equal(parseIndexLine(''), null, 'blank line');
assert.equal(parseIndexLine('# Header'), null, 'header line');
assert.equal(parseIndexLine('  plain text'), null, 'plain text');

const p1 = parseIndexLine('- [Homelab Server](homelab-server.md) [pin] 2026-07-20 -- summary');
assert.equal(p1.name, 'Homelab Server');
assert.equal(p1.filename, 'homelab-server.md');
assert(p1.rest.includes('[pin]'), 'pin token present');
assert(!p1.rest.includes('[stale?]'), 'no stale token');

const p2 = parseIndexLine('- [Old Topic](old.md) 2025-01-01 [stale?] -- old');
assert.equal(p2.name, 'Old Topic');
assert(p2.rest.includes('[stale?]'), 'stale token present');
assert(!p2.rest.includes('[pin]'), 'no pin token');

// --- toSlug ---

assert.equal(toSlug('PostgreSQL Setup'), 'postgresql-setup');
assert.equal(toSlug('Homelab Server (v2)'), 'homelab-server-v2');
assert.equal(toSlug('  spaces   and   dashes  '), 'spaces-and-dashes');
assert.equal(toSlug('npm Packaging and GitHub Release Workflow'), 'npm-packaging-and-github-release-workflow');
assert.equal(toSlug('already-slugged'), 'already-slugged');

// --- parseConfig ---

assert.deepEqual(parseConfig(null), { maxLines: 200, staleAfterDays: 180 }, 'null = defaults');
assert.deepEqual(parseConfig(''), { maxLines: 200, staleAfterDays: 180 }, 'empty = defaults');
assert.deepEqual(parseConfig('# max_lines: 300\n'), { maxLines: 200, staleAfterDays: 180 }, 'commented = ignored');
assert.deepEqual(parseConfig('max_lines: 300\nstale_after_days: 90\n'), { maxLines: 300, staleAfterDays: 90 });
assert.equal(parseConfig('max_lines: 10\n').maxLines, 50, 'clamped to min 50');
assert.equal(parseConfig('max_lines: 999\n').maxLines, 500, 'clamped to max 500');
assert.equal(parseConfig('stale_after_days: 0\n').staleAfterDays, 0, 'zero disables flagging');

// --- daysSince ---

assert.equal(daysSince('invalid'), null, 'bad date = null');
assert.equal(daysSince('not-a-date'), null, 'bad format = null');
assert(daysSince(today()) <= 0, 'today = 0 or -1');
assert(daysSince('2020-01-01') > 1000, 'old date > 1000 days');

// --- findIndexEntry ---

const idx = [
  '# Memory Index', '',
  '- [Homelab Server](homelab-server.md) [pin] 2026-07-20 -- Intel i5...',
  '- [Fedora Workstation](workstation.md) [pin] 2026-07-20 -- Ryzen 7...',
  '',
];

assert.equal(findIndexEntry(idx, 'homelab').parsed.name, 'Homelab Server', 'name match');
assert.equal(findIndexEntry(idx, 'workstation.md').parsed.filename, 'workstation.md', 'filename match');
assert.equal(findIndexEntry(idx, 'fedora').parsed.name, 'Fedora Workstation', 'partial name match');
assert.equal(findIndexEntry(idx, 'HOMELAB').parsed.name, 'Homelab Server', 'case-insensitive');
assert.equal(findIndexEntry(idx, 'missing'), null, 'no match = null');
assert.equal(findIndexEntry(idx, 'homelab').idx, 2, 'correct line index returned');

// --- upsertIndexLine ---

// update existing — preserve existing [pin], update date and summary
const lines1 = [...idx];
upsertIndexLine(lines1, 'homelab-server.md', 'Homelab Server', 'new summary', false);
assert(lines1[2].includes('[pin]'), 'existing pin preserved when pin=false');
assert(lines1[2].includes('new summary'), 'summary updated');
assert(lines1[2].includes(today()), 'date updated to today');

// update existing — add pin when not already pinned
const lines2 = [
  '# Memory Index', '',
  '- [No Pin Topic](no-pin.md) 2026-01-01 -- unpinned',
];
upsertIndexLine(lines2, 'no-pin.md', 'No Pin Topic', 'still unpinned', false);
assert(!lines2[2].includes('[pin]'), 'no pin added when pin=false and not already pinned');

upsertIndexLine(lines2, 'no-pin.md', 'No Pin Topic', 'now pinned', true);
assert(lines2[2].includes('[pin]'), 'pin added when pin=true');

// new entry appended
const lines3 = [...idx];
const before = lines3.length;
upsertIndexLine(lines3, 'new.md', 'New Topic', 'brand new', true);
assert.equal(lines3.length, before + 1, 'one line added');
assert(lines3[lines3.length - 1].includes('[New Topic](new.md)'), 'correct link');
assert(lines3[lines3.length - 1].includes('[pin]'), 'pin on new entry');
assert(lines3[lines3.length - 1].includes(today()), 'date on new entry');

// new entry without pin
const lines4 = [...idx];
upsertIndexLine(lines4, 'plain.md', 'Plain Topic', 'no pin', false);
assert(!lines4[lines4.length - 1].includes('[pin]'), 'no pin on new entry when pin=false');

console.log('All tests passed.');
