import fs from 'fs';
import path from 'path';
import {
  MEMORY_DIR, MEMORY_CONFIG, INITIAL_MEMORY, parseIndexLine,
  stripJsonc, readMemoryRules, parseRules, getMemoryDir, getMemoryIndex, getDirtySentinel,
  ensureMemoryDir, atomicWriteFileSync, sleep, withLock, acquireLock, releaseLock, LockContendedError,
  maybeCarryOverToSharedDir, isSafeFilename, isRegularFile, readStoreFileSync,
  readRemovedList, addToRemovedList, removeFromRemovedList, hasIndexFlag,
} from './ocl-memory-shared.mjs';

const MAX_BYTES = 50 * 1024;
// Parity with openpi-memory's MAX_SUMMARY_LENGTH: index summaries are
// whitespace-collapsed and capped so one rambling summary cannot eat the
// whole 50 KB injection budget.
const MAX_SUMMARY_LENGTH = 500;

const CONSOLIDATION_PROMPT = `Review the current conversation for facts, decisions, or discoveries that match the "always_persist" rules in ${MEMORY_CONFIG} but have not yet been written to memory. For each one found, call write_memory with an appropriate topic, content, summary, and pin value.

Then write or update a topic named "OCL Last Session Recap" (toSlug of that name is exactly ocl-last-session-recap.md — use this topic string verbatim so repeated consolidations update ONE recap instead of creating duplicates) summarizing what was accomplished this session, using mode: "replace" so it always reflects only the most recent session. Do not pin this entry — it is meant to be overwritten every session.

If no new durable facts were found, say so plainly and only refresh the recap.`;

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

Then write or update a topic named "OCL Last Session Recap" (toSlug of that name is exactly ocl-last-session-recap.md — use this topic string verbatim so repeated consolidations update ONE recap instead of creating duplicates) summarizing what was accomplished this session, using mode: "replace" so it always reflects only the most recent session. Do not pin this entry — it is meant to be overwritten every session.

After consolidating, continue with any pending work described in the summary's "Next Move" section. If there is no pending work, stop.`;

// --- In-process cache ---
// Memory is global, so sessions can share a cache. Check filesystem identity
// before reuse; never consume a notification that another process still needs.
let _cache = null;
let _requestCount = 0;

function fileStamp(filePath) {
  try {
    const s = fs.lstatSync(filePath, { bigint: true });
    let stamp = `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
    if (s.isSymbolicLink()) {
      try {
        const target = fs.statSync(filePath, { bigint: true });
        stamp += `>${target.dev}:${target.ino}:${target.size}:${target.mtimeNs}:${target.ctimeNs}`;
      } catch (err) { stamp += `>${err.code}`; }
    }
    return stamp;
  } catch (err) { if (err.code === 'ENOENT') return ''; throw err; }
}

function cacheSignature(memDir, configStamp = fileStamp(MEMORY_CONFIG)) {
  return [configStamp, ...[memDir, path.join(memDir, 'MEMORY.md'), path.join(memDir, '.ocl-removed'), getDirtySentinel(memDir)].map(fileStamp)].join('|');
}

async function getCache(forceRefresh = false) {
  if (_cache && _cache.signature !== cacheSignature(_cache.memDir)) _cache = null;
  if (!_cache || forceRefresh) {
    const configStamp = fileStamp(MEMORY_CONFIG);
    const rules = readMemoryRules();
    const config = parseRules(rules);
    await maybeCarryOverToSharedDir(config);
    const renderedRules = renderRulesForInjection(rules);
    const memDir = getMemoryDir(config);
    const signature = cacheSignature(memDir, configStamp);
    const content = readMemoryIndex(config.maxLines, memDir);
    // Only meaningful under shared_dir (a co-tenant is the realistic cause of
    // index/file drift); cheap readdir+read, computed once per cache refresh.
    const drift = config.sharedDir ? countMemoryFiles(memDir, getMemoryIndex(config)) : null;
    _cache = { renderedRules, config, content, memDir, drift, signature };
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
      return INITIAL_MEMORY; // do not create on a read path; tools create it under lock
    }
    const raw = readStoreFileSync(indexPath, MAX_BYTES + 1);
    const lines = raw.split('\n');
    const lineLimitExceeded = lines.length > maxLines;
    const limitedLines = lines.slice(0, maxLines);
    const byteLimitExceeded = Buffer.byteLength(raw) > MAX_BYTES;
    if (!lineLimitExceeded && !byteLimitExceeded) return raw;

    const warning = lineLimitExceeded
      ? `<!-- memory truncated: MEMORY.md exceeds ${maxLines}-line limit; shorten the index -->`
      : `<!-- memory truncated: MEMORY.md exceeds ${Math.round(MAX_BYTES / 1024)} KB size limit; shorten the index -->`;
    const budget = MAX_BYTES - Buffer.byteLength(`\n\n${warning}`);
    const kept = [];
    let bytes = 0;
    for (const line of limitedLines) {
      const prefix = kept.length ? '\n' : '';
      const lineBytes = Buffer.byteLength(prefix + line);
      if (bytes + lineBytes > budget) break;
      kept.push(line);
      bytes += lineBytes;
    }
    return kept.join('\n') + `\n\n${warning}`;
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
  const pinned = new Set();
  const timestamp = rest => Date.parse((rest.split(' -- ')[0].match(/\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))?/) || [''])[0]) || 0;
  for (const line of lines) {
    const parsed = parseIndexLine(line);
    if (!parsed) continue;
    const { filename } = parsed;
    if (!isSafeFilename(filename)) continue; // corrupted/unsafe entry — drop like an orphan
    if (!isRegularFile(path.join(memDir, filename))) continue;
    const date = timestamp(parsed.rest);
    if (hasIndexFlag(parsed.rest, '[pin]')) pinned.add(filename);
    const prev = best.get(filename);
    const prevDate = prev ? timestamp(parseIndexLine(prev).rest) : 0;
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
    const isPinned = pinned.has(filename);
    if (isPinned && !hasIndexFlag(rest, '[pin]')) rest = ' [pin]' + rest;
    const separator = rest.indexOf(' -- ');
    const summary = separator === -1 ? '' : rest.slice(separator);
    rest = separator === -1 ? rest : rest.slice(0, separator);
    if (isPinned || staleAfterDays === 0) rest = rest.replace(/\s*\[stale\?\]/g, '');
    if (!isPinned && staleAfterDays > 0) {
      const dateMatch = rest.match(/(\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))?)/);
      if (dateMatch) {
        const age = daysSince(dateMatch[1]);
        if (age !== null && age > staleAfterDays) {
          if (!rest.includes('[stale?]')) rest = rest.replace(dateMatch[1], dateMatch[1] + ' [stale?]');
        } else {
          rest = rest.replace(' [stale?]', '');
        }
      }
    }

    result.push(winner.prefix + winner.name + winner.mid + rest + summary);
  }

  return result;
}

// --- Shared index search helper ---
// Locate an index entry by (case-insensitive) search string, matching openpi-memory's
// semantics: an exact match on name or filename wins outright; otherwise a SINGLE
// substring match is returned; MULTIPLE substring matches return an ambiguity signal
// so callers refuse to mutate the wrong entry instead of silently taking the first.
// Returns { idx, parsed } | { ambiguous: true, names: string[] } | null.

function findIndexEntry(lines, search) {
  const s = search.toLowerCase();
  const substringMatches = [];
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseIndexLine(lines[i]);
    if (!parsed) continue;
    const name = parsed.name.toLowerCase();
    const file = parsed.filename.toLowerCase();
    if (name === s || file === s) return { idx: i, parsed };
    if (name.includes(s) || file.includes(s)) substringMatches.push({ idx: i, parsed });
  }
  if (substringMatches.length === 1) return substringMatches[0];
  if (substringMatches.length > 1) {
    return { ambiguous: true, names: substringMatches.map(m => m.parsed.name) };
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

// A MEMORY.md record is ONE physical line: `- [name](file.md) date -- summary`.
// The topic name and summary are user/agent text that could otherwise contain
// newlines (which would split one record into two, letting a crafted summary
// inject a phantom index line — a real hazard under shared_dir where a
// co-tenant trusts foreign lines) or `[]()` (which break parseIndexLine).
// Collapse newlines to spaces and strip link metacharacters before a value
// lands on an index line. Frontmatter is already safe (JSON.stringify escapes
// newlines); this covers the flatfile index only.
function sanitizeIndexField(s) {
  return String(s == null ? '' : s)
    .replace(/[\r\n]+/g, ' ')
    .replace(/[[\]()]/g, '');
}

// --- Index upsert ---
// Finds and updates an existing index line for the given filename, or appends a new one.
// Returns updated lines array.

function upsertIndexLine(lines, filename, name, summary, pin) {
  const dateStr = nowIso();
  name = sanitizeIndexField(name);
  summary = sanitizeIndexField(summary);

  for (let i = 0; i < lines.length; i++) {
    const parsed = parseIndexLine(lines[i]);
    if (!parsed) continue;
    if (parsed.filename === filename) {
      const effectivePin = hasIndexFlag(parsed.rest, '[pin]') || pin;
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

// --- Index repair (co-tenancy drift recovery) ---
// Reads a topic file's YAML frontmatter, tolerant of quoted/unquoted values
// and of files with no/short frontmatter. Extracts the display name, the
// one-line description, and the most relevant timestamp.
function readFrontmatter(filePath) {
  const fallbackName = path.basename(filePath).replace(/\.md$/, '');
  try {
    const text = readStoreFileSync(filePath, MAX_BYTES);
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    const block = m ? m[1] : '';
    const unquote = v => {
      const value = v.trim();
      if (value.startsWith('"')) { try { const decoded = JSON.parse(value); if (typeof decoded === 'string') return decoded; } catch {} }
      return value.replace(/^['"]|['"]$/g, '');
    };
    const grab = key => {
      const km = block.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
      return km ? unquote(km[1]) : '';
    };
    return {
      name: grab('name') || fallbackName,
      description: grab('description'),
      // strip newlines so a malformed co-tenant timestamp can never split an
      // index record across two physical lines (brackets are dropped by
      // sanitizeIndexField at the repair emit site)
      ts: (grab('last_updated') || grab('created') || nowIso()).replace(/[\r\n]+/g, ' ').trim(),
    };
  } catch {
    return { name: fallbackName, description: '', ts: nowIso() };
  }
}

// Counts non-MEMORY topic .md files on disk vs indexed filenames, for the
// drift signal. Skips unsafe names (which would be dropped by maintainIndex
// anyway) so the count reflects legitimately recoverable files, and skips
// tombstoned files (remove_memory deliberately keeps the topic file on disk
// while dropping its index line — repair skips them too, so counting them as
// "drift" would make the maintenance note a permanent false positive).
function countMemoryFiles(memDir, memIndex) {
  let fileCount = 0;
  try {
    const removed = readRemovedList(memDir);
    fileCount = fs.readdirSync(memDir)
      .filter(f => isSafeFilename(f) && !removed.has(f) && isRegularFile(path.join(memDir, f))).length;
  } catch {}
  let indexedCount = 0;
  try {
    indexedCount = new Set(
      readStoreFileSync(memIndex).split('\n').map(parseIndexLine).filter(e => e && isSafeFilename(e.filename)).map(e => e.filename)
    ).size;
  } catch {}
  return { fileCount, indexedCount };
}

// Additively re-index topic files that exist on disk but are missing from the
// index (e.g. after a co-tenant rewrote MEMORY.md from its own smaller set).
// NEVER deletes, reorders, or touches existing lines. Recovered entries carry
// [stale?] so the agent re-validates them, and are dated from each file's own
// frontmatter timestamp. Safe to call repeatedly (idempotent). Returns
// { added, alreadyIndexed }.
function repairMemoryIndex({ memDir, memIndex }) {
  const index = fs.existsSync(memIndex) ? readStoreFileSync(memIndex) : INITIAL_MEMORY;
  const indexed = new Set(index.split('\n').map(parseIndexLine).filter(Boolean).map(e => e.filename));
  const alreadyIndexed = indexed.size;
  const removed = readRemovedList(memDir); // intentionally-removed topics — never resurrect
  const added = [];
  let files = [];
  try { files = fs.readdirSync(memDir); } catch {}
  for (const file of files) {
    if (!file.endsWith('.md') || file === 'MEMORY.md') continue;
    if (!isSafeFilename(file)) continue;      // never re-introduce an unsafe/traversal name
    if (!isRegularFile(path.join(memDir, file))) continue;
    if (indexed.has(file)) continue;           // already present — additive only
    if (removed.has(file)) continue;           // deliberately removed via remove_memory — skip
    const fm = readFrontmatter(path.join(memDir, file));
    // sanitizeIndexField on every recovered field — including ts: a corrupted
    // co-tenant frontmatter timestamp like "2026-01-01 [pin]" must not smuggle
    // a pin token (or a phantom `--` summary separator) onto the index line.
    const name = sanitizeIndexField(fm.name).trim() || file.slice(0, -3).trim() || file;
    const ts = sanitizeIndexField(fm.ts).trim().split(' -- ')[0];
    added.push(`- [${name}](${file}) ${ts} [stale?] -- ${sanitizeIndexField(fm.description || name)}`);
    indexed.add(file);
  }
  if (added.length) {
    atomicWriteFileSync(memIndex, index.replace(/\n+$/, '') + '\n' + added.join('\n') + '\n');
  }
  return { added: added.length, alreadyIndexed };
}

// --- Tool definitions ---

const MEMORY_TOOL_NAMES = new Set(['write_memory', 'remove_memory', 'pin_memory', 'repair_memory']);

// Returned by a mutation when a shared-dir lock stayed contended through
// withLock()'s full patience window (poll + one sleep + poll). Failing closed
// here is deliberate: silently writing unlocked would race a co-tenant's
// in-flight index update and lose entries.
const BUSY_MESSAGE = 'Error: memory store is busy (another tool or process holds the lock) — please retry in a moment.';

// How many more topic files than indexed entries triggers the passive
// "/memory repair" drift note in injection. A small buffer avoids noisy
// false positives from transient in-flight writes.
const DRIFT_NOTE_THRESHOLD = 5;

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
      // Sanitize the topic up front so filename matching, frontmatter name, and
      // the index line all use the SAME clean value (a raw `]` in the name
      // would otherwise break parseIndexLine on read-back). A topic of only
      // metacharacters sanitizes to empty -> treat as missing.
      const cleanTopic = sanitizeIndexField(topic).trim();
      if (!cleanTopic) return 'Error: topic is required and must be a non-empty string.';
      // Collapse to one clean line and cap length (openpi-memory parity) BEFORE
      // any use, so the frontmatter description, the index line, and the
      // returned Entry line all carry the SAME summary value.
      const cleanSummary = sanitizeIndexField(summary).replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY_LENGTH);
      const pinBool = pin === true || pin === 'true';

      const { config } = await getCache();
      const memDir = getMemoryDir(config);
      const memIndex = getMemoryIndex(config);
      ensureMemoryDir(memDir);

      try {
        return await withLock(memDir, async () => {
          // Read index once — reuse for topic-name lookup and upsert
          const rawIndex = fs.existsSync(memIndex)
            ? readStoreFileSync(memIndex)
            : INITIAL_MEMORY;

          // Check if an existing index entry matches this topic name — use its filename if so
          let filename = toSlug(cleanTopic) + '.md';
          // A topic with no slug-formable characters (e.g. "!!!") would produce
          // ".md" — reject cleanly rather than write a file the read-back guard
          // (isSafeFilename rejects leading-dot names) would silently orphan.
          if (!isSafeFilename(filename)) {
            return 'Error: topic must contain at least one letter or digit to form a valid filename.';
          }
          let matchedExisting = false;
          for (const line of rawIndex.split('\n')) {
            const parsed = parseIndexLine(line);
            if (parsed && parsed.name.toLowerCase() === cleanTopic.toLowerCase()) {
              if (!isSafeFilename(parsed.filename)) {
                return `Entry has an unsafe filename (${parsed.filename}) and was not modified. This may indicate a corrupted index — inspect it manually.`;
              }
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
            const removedSet = readRemovedList(memDir);
            // A tombstoned file (a topic the user deliberately removed but whose
            // file we kept) is RECLAIMED by a fresh write of that topic — not
            // bumped like an unrelated slug collision. removeFromRemovedList()
            // below clears the tombstone. Only genuinely-unrelated existing files
            // force a numeric suffix.
            while (fs.existsSync(path.join(memDir, filename))) {
              const candidate = path.join(memDir, filename);
              if (removedSet.has(filename) && isRegularFile(candidate)
                && readFrontmatter(candidate).name.toLowerCase() === cleanTopic.toLowerCase()) break;
              filename = `${base}-${n}.md`;
              n++;
            }
          }
          const topicPath = path.join(memDir, filename);
          const previous = fs.existsSync(topicPath) ? readStoreFileSync(topicPath) : null;
          const isNew = previous === null;
          const now = nowIso();
          const match = previous?.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
          let fm = match ? match[1].replace(/\r\n/g, '\n') : 'metadata:\n  node_type: memory';
          const fields = { name: JSON.stringify(cleanTopic), description: JSON.stringify(cleanSummary), last_updated: now };
          if (!/^created:/m.test(fm)) fields.created = now;
          for (const [key, value] of Object.entries(fields)) {
            const re = new RegExp(`^${key}:.*$`, 'm');
            fm = re.test(fm) ? fm.replace(re, () => `${key}: ${value}`) : fm + `\n${key}: ${value}`;
          }
          const oldBody = match ? previous.slice(match[0].length) : previous || '';
          const body = isNew || mode === 'replace' ? '\n' + content + '\n' : oldBody + `\n## ${now}\n\n${content}\n`;
          const wasRemoved = readRemovedList(memDir).has(filename);
          let indexWritten = false;
          try {
            atomicWriteFileSync(topicPath, `---\n${fm}\n---\n${body}`);
            let lines = upsertIndexLine(rawIndex.split('\n'), filename, cleanTopic, cleanSummary, pinBool);
            lines = maintainIndex(lines, config, memDir);
            atomicWriteFileSync(memIndex, lines.join('\n'));
            indexWritten = true;
            removeFromRemovedList(memDir, filename);
          } catch (error) {
            try {
              if (indexWritten) atomicWriteFileSync(memIndex, rawIndex);
              if (previous !== null) atomicWriteFileSync(topicPath, previous);
              else if (fs.existsSync(topicPath)) fs.unlinkSync(topicPath);
              if (wasRemoved) addToRemovedList(memDir, filename);
            } catch (rollbackError) {
              throw new AggregateError([error, rollbackError], `Memory update and rollback failed; inspect ${topicPath} and ${memIndex}.`);
            }
            throw error;
          } finally { invalidateCache(); }

          return `Memory ${isNew ? 'created' : 'updated'}: ${topicPath}\nIndex updated: ${memIndex}\nEntry: [${cleanTopic}](${filename}) ${nowIso()} -- ${cleanSummary}`;
        }, { strict: config.sharedDir });
      } catch (e) {
        if (e instanceof LockContendedError) return BUSY_MESSAGE;
        throw e;
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

      try {
        return await withLock(memDir, async () => {
          const raw = readStoreFileSync(memIndex);
          const lines = raw.split('\n');

          const found = findIndexEntry(lines, search);
          if (!found) {
            return `No matching entry found for "${topic}".`;
          }
          if (found.ambiguous) {
            return `Multiple entries match "${topic}" — be more specific (exact names win over partial matches). Candidates: ${found.names.join(', ')}. Nothing was modified.`;
          }
          const { idx: foundIdx, parsed } = found;

          if (!isSafeFilename(parsed.filename)) {
            return `Entry has an unsafe filename (${parsed.filename}) and was not modified. This may indicate a corrupted index — inspect it manually.`;
          }

          if (lines.map(parseIndexLine).some(p => p && p.filename === parsed.filename && hasIndexFlag(p.rest, '[pin]'))) {
            return `Entry is pinned and cannot be removed. Use pin_memory with pin: false to unpin it first.`;
          }

          const removedLine = lines[foundIdx];
          const remaining = lines.filter(line => parseIndexLine(line)?.filename !== parsed.filename);
          const maintained = maintainIndex(remaining, config, memDir);

          addToRemovedList(memDir, parsed.filename); // tombstone: repair must not resurrect this
          atomicWriteFileSync(memIndex, maintained.join('\n'));
          invalidateCache();

          const topicFile = path.join(memDir, parsed.filename);
          const fileNote = fs.existsSync(topicFile)
            ? `Topic file ${parsed.filename} still exists on disk (marked as intentionally removed — /memory repair will skip it).`
            : `Topic file ${parsed.filename} was not found on disk.`;

          return `Index entry removed: ${removedLine.trim()}\n${fileNote}`;
        }, { strict: config.sharedDir });
      } catch (e) {
        if (e instanceof LockContendedError) return BUSY_MESSAGE;
        throw e;
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

      try {
        return await withLock(memDir, async () => {
          const raw = readStoreFileSync(memIndex);
          const lines = raw.split('\n');

          const found = findIndexEntry(lines, search);
          if (!found) {
            return `No matching entry found for "${topic}".`;
          }
          if (found.ambiguous) {
            return `Multiple entries match "${topic}" — be more specific (exact names win over partial matches). Candidates: ${found.names.join(', ')}. Nothing was modified.`;
          }
          const { idx: foundIdx, parsed } = found;

          if (!isSafeFilename(parsed.filename)) return 'Entry has an unsafe filename and was not modified.';
          const line = lines[foundIdx];
          const alreadyPinned = lines.map(parseIndexLine).some(p => p && p.filename === parsed.filename && hasIndexFlag(p.rest, '[pin]'));

          if (pinBool && alreadyPinned) return `Already pinned: ${line.trim()}`;
          if (!pinBool && !alreadyPinned) return `Already unpinned: ${line.trim()}`;

          const before = line.trim();
          for (let i = 0; i < lines.length; i++) {
            const entry = parseIndexLine(lines[i]);
            if (!entry || entry.filename !== parsed.filename) continue;
            const rest = pinBool
              ? (hasIndexFlag(entry.rest, '[pin]') ? entry.rest : ' [pin]' + entry.rest)
              : (hasIndexFlag(entry.rest, '[pin]') ? entry.rest.replace(/\s*\[pin\]/, '') : entry.rest);
            lines[i] = entry.prefix + entry.name + entry.mid + rest;
          }
          const after = lines[foundIdx].trim();

          const maintained = maintainIndex(lines, config, memDir);

          atomicWriteFileSync(memIndex, maintained.join('\n'));
          invalidateCache();

          return `${pinBool ? 'Pinned' : 'Unpinned'}.\nBefore: ${before}\nAfter:  ${after}`;
        }, { strict: config.sharedDir });
      } catch (e) {
        if (e instanceof LockContendedError) return BUSY_MESSAGE;
        throw e;
      }
    },
  },

  repair_memory: {
    description: 'Re-index topic files that exist in the memory directory but are missing from MEMORY.md (additive only — never deletes or reorders). Recovered entries are marked [stale?]. Skips topics intentionally removed via remove_memory (tracked in .ocl-removed), so deliberate removals are never resurrected. Use when shared_dir co-tenancy drift leaves topics undiscoverable.',
    args: {},
    async execute() {
      const { config } = await getCache();
      const memDir = getMemoryDir(config);
      const memIndex = getMemoryIndex(config);
      try {
        return await withLock(memDir, async () => {
          const { added, alreadyIndexed } = repairMemoryIndex({ memDir, memIndex });
          invalidateCache();
          if (added === 0) {
            return `Index already consistent — ${alreadyIndexed} topic(s) indexed, no orphaned topic files found.`;
          }
          return `Re-indexed ${added} orphaned topic file(s) as [stale?]. Index now lists ${alreadyIndexed + added} entr${alreadyIndexed + added === 1 ? 'y' : 'ies'}.`;
        }, { strict: config.sharedDir });
      } catch (e) {
        if (e instanceof LockContendedError) return BUSY_MESSAGE;
        throw e;
      }
    },
  },
};

// --- Plugin export ---

export default async (input) => {
  const client = input && input.client;
  const skillsDir = new URL('../../skills', import.meta.url).pathname;
  let commandTemplate;
  let commandDir;

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

      // Register an initial template; command.execute.before refreshes its paths.
      const { config: memConfig } = await getCache();
      const activeDir = getMemoryDir(memConfig);
      const activeIndex = getMemoryIndex(memConfig);

      // Register /memory command
      if (!config.command) config.command = {};
      config.command['memory'] = {
        description: '/memory → show index | /memory <text> → store | /memory pin <topic> → pin | /memory unpin <topic> → unpin | /memory remove <topic> → remove entry | /memory consolidate → consolidate session | /memory repair → re-index orphaned topic files',
        template: `Memory dir: ${activeDir}
Memory index: ${activeIndex}

Arguments: $ARGUMENTS

## No arguments: show index

Read ${activeIndex}. Display each entry as a table with columns: Topic (name only — no markdown links, no filenames), Date, Pinned (yes/no), Stale (yes/no). List all .md files in ${activeDir}. Do not write anything.

After listing, append this legend:
Tip: /memory <text> to store  |  /memory pin <topic> to pin  |  /memory unpin <topic> to unpin  |  /memory remove <topic> to remove  |  /memory consolidate to consolidate this session  |  /memory repair to re-index orphaned files

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

## Arguments are exactly "repair": re-index orphaned topic files

Call the repair_memory tool with no arguments:
  repair_memory({})

It additively re-indexes any .md topic file that exists in the memory dir but is missing from ${activeIndex} (marking recovered entries [stale?]), never deletes or reorders existing entries, and skips topics you intentionally removed (recorded in the dir's .ocl-removed list). Report how many were re-indexed.

## Arguments provided (not starting with "pin ", "unpin ", or "remove ", and not exactly "consolidate" or "repair"): store a memory

Treat the arguments as a fact or note to persist. Decide the topic, a slug filename, a one-line summary, and whether the topic is permanent (hardware, user identity, core workflows = pin it). Then call the write_memory tool:
  write_memory({ topic: "<topic name>", content: "<the full fact or note>", summary: "<one-line summary>", pin: <true|false>, mode: "append" })

The tool creates a new topic file or appends to an existing one, and updates the MEMORY.md index automatically.

Any text including single words is treated literally as content to store. Do not interpret "show", "list", or similar words as subcommands unless the full argument starts with "pin ", "unpin ", or "remove ", or is exactly "consolidate" or "repair".`,
      };
      commandTemplate = config.command.memory.template;
      commandDir = activeDir;
    },

    'command.execute.before': async (hookInput, output) => {
      if (hookInput.command !== 'memory' || !commandTemplate) return;
      const { memDir } = await getCache();
      const part = output.parts.find(p => p.type === 'text');
      if (part) part.text = commandTemplate.split(commandDir).join(memDir).replaceAll('$ARGUMENTS', () => hookInput.arguments || '');
    },

    tool: tools,

    // Test-only seam: expose internal helpers so their behavior can be
    // asserted directly without going through the full hook surface.
    __test__: { repairMemoryIndex, readFrontmatter, countMemoryFiles },

    // Refresh the cache after memory tools, including mutations by other plugins.
    'tool.execute.after': async (input, _output) => {
      if (MEMORY_TOOL_NAMES.has(input.tool)) {
        invalidateCache();
      }
    },

    // OpenCode constructs a fresh system prompt for EVERY model request.
    // Cache disk reads, never the presence of memory in the outgoing request.
    'experimental.chat.system.transform': async (_input, output) => {
      let cache = await getCache();
      if (++_requestCount % cache.config.injectEveryNTurns === 0) cache = await getCache(true);
      const { renderedRules, content, config, memDir, drift } = cache;
      if (content) {
        output.system.push(`## Global Memory\n\nThe following is your persistent memory index. It persists across all sessions. Topic files referenced here can be read on-demand for detail.\n\nMemory dir: ${memDir}\n\n${content}`);
        if (config.sharedDir && drift && drift.fileCount > drift.indexedCount + DRIFT_NOTE_THRESHOLD) {
          const missing = drift.fileCount - drift.indexedCount;
          output.system.push(`<!-- MEMORY MAINTENANCE: ~${missing} topic file(s) exist in the memory dir but are not in the index (possibly a co-tenant rewrote MEMORY.md). Run "/memory repair" to re-index them. -->`);
        }
      }
      if (renderedRules) {
        output.system.push(`## Memory Rules\n\nThe following rules govern what to persist or avoid persisting to memory. Edit ${MEMORY_CONFIG} to customise.\n\n${renderedRules}`);
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
      try {
        const summary = await fetchLatestCompactionSummary(hookInput.sessionID);
        const text = summary
          ? buildCompactConsolidationPrompt(summary)
          : CONSOLIDATION_PROMPT + '\n\nAfter consolidating, resume any pending work from the conversation. If there is no pending work, stop.';
        const result = await client.session.prompt({
          path: { id: hookInput.sessionID },
          body: {
            noReply: true,
            agent: hookInput.agent,
            model: hookInput.model && { providerID: hookInput.model.providerID, modelID: hookInput.model.id },
            variant: hookInput.message?.model?.variant,
            parts: [{ type: 'text', text }],
          },
        });
        if (result?.error) return;
        output.enabled = false;
      } catch {
        // best-effort — fall back to the native continue if the prompt call fails
        output.enabled = true;
      }
    },
  };
};
