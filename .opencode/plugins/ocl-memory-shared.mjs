import fs from 'fs';
import os from 'os';
import path from 'path';

// Pure-logic helpers shared between the server plugin (ocl-memory.mjs) and the
// TUI plugin (ocl-memory-tui.mjs). No plugin hooks are exported from this file
// — it is a plain internal utility module, not a "plugin" in opencode's sense,
// so importing it from both plugin files does not conflict with the type
// constraint that server/tui plugin *entry points* must stay in separate files.

export const CONFIG_ROOT = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'opencode'
);
export const MEMORY_DIR = path.join(CONFIG_ROOT, 'memory');
export const MEMORY_INDEX = path.join(MEMORY_DIR, 'MEMORY.md');
export const MEMORY_CONFIG = path.join(CONFIG_ROOT, 'memory.jsonc');

// Marks that this local install's memory has already been merged into the
// shared dir at least once. Lives in the local dir (not the shared one) —
// it's a property of the local install, independent of which dir is
// currently active. Never written on a failed/partial merge, so a failed
// attempt retries — within the same process on the next cache refresh, and
// across process starts via the missing sentinel.
export const CARRY_OVER_SENTINEL = path.join(MEMORY_DIR, '.shared-dir-migrated');
export const MEMORY_CONFIG_LEGACY = path.join(MEMORY_DIR, 'RULES.jsonc'); // pre-0.6.0 location, fallback only

// Shared cross-tool memory store — opt-in via "shared_dir": true in memory.jsonc.
// Root is overridable via OCL_SHARED_MEMORY_HOME for tests; real installs use the home dir.
export const SHARED_MEMORY_DIR = path.join(
  process.env.OCL_SHARED_MEMORY_HOME || os.homedir(),
  '.agents', 'memory'
);

export const INITIAL_MEMORY = `# Memory Index

`;

// Parses a single index line into parts. Returns null if not a memory entry line.
// Line format: - [Topic Name](file.md) [pin] YYYY-MM-DD [stale?] -- summary
export function parseIndexLine(line) {
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

const MAX_LINES = 300;
const DEFAULT_STALE_DAYS = 180;
const DEFAULT_INJECT_INTERVAL = 5;

const LOCK_STALE_MS = 10000;
const LOCK_ACQUIRE_TIMEOUT_MS = 500;      // local, best-effort single poll window
const LOCK_ACQUIRE_TIMEOUT_MS_SHARED = 2000; // shared, per poll window (see withLock retry)
const LOCK_RETRY_DELAY_MS = 1000;         // strict mode: sleep, then one more full window
const LOCK_STALE_HARD_MS = 60000;         // unparseable-pid locks may only be stolen past this
const LOCK_POLL_INTERVAL_MS = 25;

// Thrown by withLock() in strict (shared_dir) mode when the lock could not be
// acquired within its full patience window (poll + one sleep + poll again).
// Callers translate this into a "store busy" tool result instead of writing.
export class LockContendedError extends Error {}

// lockPath -> token THIS process wrote into it. Lets releaseLock() do a
// compare-and-delete: never unlink a file a stale-reclaimer stole from us
// mid-critical-section. Only ever holds locks we currently believe we own.
const _lockTokens = new Map();

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
  // max_lines: valid range 50–1000
  "max_lines": 300,
  // stale_after_days: 0 = disable age flagging
  "stale_after_days": 180,
  // inject_every_n_turns: re-inject memory every N user prompts; 1 = every prompt
  "inject_every_n_turns": 5,
  // shared_dir: true = store MEMORY.md and topic files at ~/.agents/memory/
  // so other tools (e.g. pi's openpi-memory) can read/write the same files.
  // This file (memory.jsonc) always stays local regardless of this setting.
  "shared_dir": false,
  // consolidate_on_compact: true = after automatic compaction, run a
  // consolidation pass instead of opencode's default "continue" nudge.
  "consolidate_on_compact": false
}
`;

// One-time carry-over guard — see maybeCarryOverToSharedDir(). Process-global,
// same caveat as the rest of this module's state: fine for a standard single
// opencode process, not designed for multi-process coordination (though the
// function's own fs.existsSync short-circuit makes a double-run across two
// separate processes harmless).
let _carryOverChecked = false;

export function getMemoryDir(config) {
  return config && config.sharedDir ? SHARED_MEMORY_DIR : MEMORY_DIR;
}

export function getMemoryIndex(config) {
  return path.join(getMemoryDir(config), 'MEMORY.md');
}

// The cache-busting sentinel always lives alongside whichever directory is
// currently active (local or shared) — never a fixed path — so any writer
// (server plugin tools or the TUI) and any reader (server plugin's getCache)
// agree on where to look regardless of shared_dir.
export function getDirtySentinel(memDir) {
  return path.join(memDir, '.invalidate');
}

// Tombstone list of INTENTIONALLY removed topics (via remove_memory). One
// topic filename per line, stored inside the ACTIVE memory dir. repair_memory
// skips anything listed here so a deliberate removal is never resurrected as
// an "orphan" by a later co-tenancy repair. NOT private under shared_dir:
// openpi-memory deliberately reads and writes the same `.ocl-removed` path
// in the shared dir, so a removal made by either tool is honored by both.
// In local mode the file exists only in our local dir and no one else sees
// it. A topic re-written by write_memory has its entry cleared.
export function getRemovedListPath(memDir) {
  return path.join(memDir, '.ocl-removed');
}

export function readRemovedList(memDir) {
  try {
    return new Set(
      fs.readFileSync(getRemovedListPath(memDir), 'utf8')
        .split('\n')
        .map(s => s.trim())
        .filter(s => s && isSafeFilename(s))
    );
  } catch {
    return new Set();
  }
}

export function addToRemovedList(memDir, filename) {
  const set = readRemovedList(memDir);
  if (set.has(filename)) return; // deduped
  set.add(filename);
  ensureMemoryDir(memDir);
  atomicWriteFileSync(getRemovedListPath(memDir), [...set].join('\n') + '\n');
}

export function removeFromRemovedList(memDir, filename) {
  const set = readRemovedList(memDir);
  if (!set.has(filename)) return; // no-op, avoid a needless write
  set.delete(filename);
  atomicWriteFileSync(
    getRemovedListPath(memDir),
    set.size ? [...set].join('\n') + '\n' : ''
  );
}

export function ensureMemoryDir(dir = MEMORY_DIR) {
  fs.mkdirSync(dir, { recursive: true });
}

// Writes via temp file + rename so a crash or concurrent read never observes
// a partially-written file. Same directory as the target to keep rename atomic.
export function atomicWriteFileSync(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, filePath);
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Cross-process advisory lock. Guards MEMORY.md read-modify-write sections so
// concurrent writers (this plugin's tools, the TUI, or another process/tool
// sharing the same dir) don't interleave writes into corrupted or duplicated
// index lines. wx create fails if the lock already exists. The payload is a
// token `pid\tts\trand` (field 0 pid matches openpi-memory's format, so each
// tool parses the other's lock); releaseLock only unlinks while the content
// still equals OUR token. A lock older than LOCK_STALE_MS is a reclaim
// CANDIDATE, but is only actually stolen when its recorded pid is provably
// dead (process.kill(pid, 0) throws) — and immediately before unlinking we
// RE-STAT and compare inode+mtime against the lock we observed: a competing
// reclaimer may already have replaced it (its wx-create succeeded after our
// age check), and unlinking THAT would put us both inside the critical
// section. Residual window between the recheck and the unlink is microseconds,
// and the compare-and-delete release means neither loser clobbers the other's
// lock on exit. A lock with an unparseable pid (foreign writer, empty file)
// is only stolen past LOCK_STALE_HARD_MS, so it is at worst briefly unfair,
// never silently clobbering an active writer.
// Returns the lockPath on success, or null after `timeoutMs` of contention.
// Callers that must not proceed unlocked should use withLock() instead.
export async function acquireLock(memDir, timeoutMs = LOCK_ACQUIRE_TIMEOUT_MS) {
  ensureMemoryDir(memDir);
  const lockPath = path.join(memDir, '.lock');
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const token = `${process.pid}\t${Date.now()}\t${Math.random().toString(36).slice(2)}`;
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, token);
      fs.closeSync(fd);
      _lockTokens.set(lockPath, token);
      return lockPath;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const stat = fs.statSync(lockPath);
        const age = Date.now() - stat.mtimeMs;
        if (age > LOCK_STALE_MS && !lockHolderAlive(lockPath, age)) {
          let fresh;
          try { fresh = fs.statSync(lockPath); } catch { continue; } // vanished — retry acquire
          if (fresh.ino === stat.ino && fresh.mtimeMs === stat.mtimeMs) {
            try { fs.unlinkSync(lockPath); } catch {}
          }
          continue; // retry acquire (immediately, or against the new holder)
        }
      } catch {}
      if (Date.now() > deadline) return null;
      await sleep(LOCK_POLL_INTERVAL_MS);
    }
  }
}

// True if the lock's recorded pid refers to a still-running process. An
// unparseable/absent pid is treated as "assume alive" unless the lock is far
// past the soft stale window (LOCK_STALE_HARD_MS), to avoid stealing a lock
// from a co-tenant that writes an empty or pid-only file.
function lockHolderAlive(lockPath, age) {
  let pid;
  try {
    const raw = fs.readFileSync(lockPath, 'utf8').trim();
    pid = parseInt(raw.split('\t')[0], 10);
  } catch {
    pid = NaN;
  }
  if (Number.isInteger(pid)) {
    try { process.kill(pid, 0); return true; } catch { return false; } // ESRCH → dead
  }
  return age <= LOCK_STALE_HARD_MS; // unknown pid: alive unless very old
}

export function releaseLock(lockPath) {
  if (!lockPath) return;
  const token = _lockTokens.get(lockPath);
  _lockTokens.delete(lockPath);
  if (token !== undefined) {
    // Compare-and-delete: if a stale-reclaimer stole the lock while our
    // critical section ran long, the content is THEIRS now — leave it alone.
    // (No recorded token means this lock was never acquired by us; unlink
    // unconditionally, preserving the old direct-call behavior.)
    let raw;
    try { raw = fs.readFileSync(lockPath, 'utf8'); } catch { return; } // gone — nothing to release
    if (raw !== token) return;
  }
  try { fs.unlinkSync(lockPath); } catch {}
}

// Run `fn` while holding the directory lock. This is the single entry point
// every mutation should use (server tools, TUI, carry-over) so the
// contention/retry policy lives in one place.
//   - Default (strict: false): best-effort. If the lock can't be acquired
//     within timeoutMs, `fn` still runs WITHOUT the lock. Correct for a local,
//     single-writer directory; preserves prior non-blocking behavior.
//   - strict: true (used whenever shared_dir is active): never run `fn`
//     unlocked. On contention, poll one window; if that fails, sleep
//     LOCK_RETRY_DELAY_MS and poll again; if STILL contended, throw
//     LockContendedError so the caller reports "store busy" instead of
//     clobbering a co-tenant's in-flight index update.
export async function withLock(memDir, fn, { strict = false, timeoutMs } = {}) {
  const tmo = timeoutMs != null ? timeoutMs : (strict ? LOCK_ACQUIRE_TIMEOUT_MS_SHARED : LOCK_ACQUIRE_TIMEOUT_MS);
  const lockPath = await acquireLock(memDir, tmo);
  if (lockPath) {
    try { return await fn(); } finally { releaseLock(lockPath); }
  }
  if (!strict) return await fn(); // best-effort proceed without the lock
  await sleep(LOCK_RETRY_DELAY_MS);
  const retryPath = await acquireLock(memDir, tmo);
  if (retryPath) {
    try { return await fn(); } finally { releaseLock(retryPath); }
  }
  throw new LockContendedError('memory store busy — could not acquire lock after retry');
}

export const stripJsonc = raw => {
  // String-literal-aware JSONC comment stripper. A naive `//`-strip regex
  // would truncate a config value containing a URL (e.g. "https://example.com")
  // mid-string, corrupting the JSON. This tracks quote state so `//` (and the
  // trailing-comma cleanup below) only strip outside of string literals.
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && raw[i + 1] === '/') {
      i += 2;
      while (i < raw.length && raw[i] !== '\n') i++;
      i--; // land back on '\n' (or raw.length) so the for-loop's i++ is correct
      continue;
    }
    // Block comment: /* ... */ — only outside a string literal. A `*/` inside
    // a config value (e.g. a path glob) must NOT terminate it early.
    if (ch === '/' && raw[i + 1] === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
      i++; // land on the '/' of the closing '*/' so the for-loop's i++ skips it
      continue;
    }
    out += ch;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
};

// Rejects filenames that could escape memDir (path separators, `..` segments)
// or corrupt the line-oriented MEMORY.md index. Brackets/parens are rejected
// because they break parseIndexLine's `- [name](filename)` shape, and a
// leading dot marks tool-internal / hidden files (.ocl-removed, .lock, dotfiles)
// that are never topics. toSlug() already prevents all of these on the write
// path for brand-new topics, but a filename read back from an existing
// MEMORY.md index line (or a co-tenant's directory listing) is otherwise
// trusted verbatim — apply this before using such a filename in any path.join
// or file operation.
export function isSafeFilename(filename) {
  return typeof filename === 'string'
    && filename.length > 0
    && !filename.startsWith('.')
    && !filename.includes('/')
    && !filename.includes('\\')
    && !filename.includes('..')
    && !filename.includes('[')
    && !filename.includes(']')
    && !filename.includes('(')
    && !filename.includes(')');
}

export function parseRules(raw) {
  const defaults = {
    maxLines: MAX_LINES,
    staleAfterDays: DEFAULT_STALE_DAYS,
    injectEveryNTurns: DEFAULT_INJECT_INTERVAL,
    sharedDir: false,
    consolidateOnCompact: false,
  };
  if (!raw) return defaults;
  try {
    const obj = JSON.parse(stripJsonc(raw));
    return {
      maxLines: Math.min(1000, Math.max(50, Number.isInteger(obj.max_lines) ? obj.max_lines : defaults.maxLines)),
      staleAfterDays: typeof obj.stale_after_days === 'number' ? Math.max(0, obj.stale_after_days) : defaults.staleAfterDays,
      injectEveryNTurns: Number.isInteger(obj.inject_every_n_turns) ? Math.max(1, obj.inject_every_n_turns) : defaults.injectEveryNTurns,
      sharedDir: typeof obj.shared_dir === 'boolean' ? obj.shared_dir : defaults.sharedDir,
      consolidateOnCompact: typeof obj.consolidate_on_compact === 'boolean' ? obj.consolidate_on_compact : defaults.consolidateOnCompact,
    };
  } catch (err) {
    console.error('[openclaude-memory] memory.jsonc failed to parse, using defaults:', err.message);
    return defaults;
  }
}

export function readMemoryRules() {
  try {
    if (fs.existsSync(MEMORY_CONFIG)) {
      return fs.readFileSync(MEMORY_CONFIG, 'utf8');
    }
    // Legacy fallback: pre-0.6.0 installs kept config at memory/RULES.jsonc.
    // Back it up in place (never delete) and copy forward to the new location.
    if (fs.existsSync(MEMORY_CONFIG_LEGACY)) {
      const legacy = fs.readFileSync(MEMORY_CONFIG_LEGACY, 'utf8');
      try { fs.renameSync(MEMORY_CONFIG_LEGACY, `${MEMORY_CONFIG_LEGACY}.bak`); } catch {}
      ensureMemoryDir(CONFIG_ROOT);
      atomicWriteFileSync(MEMORY_CONFIG, legacy);
      return legacy;
    }
    ensureMemoryDir(CONFIG_ROOT);
    atomicWriteFileSync(MEMORY_CONFIG, INITIAL_RULES_JSONC);
    return INITIAL_RULES_JSONC;
  } catch (err) {
    console.error('[openclaude-memory] failed to read/write memory config:', err.message);
    return null;
  }
}

// Merge-aware carry-over when shared_dir is first enabled. Copies (never
// moves) local memory files into the shared dir. If the shared dir already
// has content (from another tool, or a prior run of this one), local entries
// are merged in rather than skipped — collisions are resolved by content
// comparison, only renaming (suffix "-oclm") when the same filename holds
// genuinely different content. Runs at most once ever per local install: the
// in-process _carryOverChecked flag short-circuits repeat calls within a
// process, and CARRY_OVER_SENTINEL (a file in the local dir, written only
// after a fully successful merge) short-circuits it across process restarts
// too, so a full merge scan never re-runs once it has ever succeeded. Toggling
// shared_dir off then on again does not re-run this or reconcile drift that
// happened while it was off — deliberate, matching openpi-memory's stance
// (see AGENTS.md quirk).
export async function maybeCarryOverToSharedDir(config) {
  if (!config.sharedDir || _carryOverChecked) return;
  _carryOverChecked = true;
  if (fs.existsSync(CARRY_OVER_SENTINEL)) return; // already migrated in a prior process
  if (!fs.existsSync(MEMORY_INDEX)) return; // nothing local to carry over
  try {
    const sharedDir = SHARED_MEMORY_DIR;
    ensureMemoryDir(sharedDir);
    await withLock(sharedDir, () => mergeLocalIntoSharedDir(sharedDir), { strict: true });
    fs.writeFileSync(CARRY_OVER_SENTINEL, '');
  } catch {
    // best-effort — carry-over failure should never break normal operation;
    // sentinel intentionally not written on failure (including a busy lock,
    // retried via withLock) so a retry can happen on the next process start
  }
}

// Merges the local MEMORY.md's entries and topic files into the shared dir.
// Entries/files already present under the same name (identical content) or
// under the canonical "-oclm" suffix (from a prior merge) are skipped —
// this is what keeps repeated runs (e.g. one per new opencode process) from
// growing duplicate/renamed copies indefinitely, since local files are frozen
// the moment shared_dir flips true (every subsequent write goes straight to
// the shared dir via getMemoryDir(config), never back to the local copy).
function mergeLocalIntoSharedDir(sharedDir) {
  const sharedIndexPath = path.join(sharedDir, 'MEMORY.md');
  const sharedRaw = fs.existsSync(sharedIndexPath) ? fs.readFileSync(sharedIndexPath, 'utf8') : INITIAL_MEMORY;
  const sharedFilesOnDisk = new Set(fs.readdirSync(sharedDir));
  const sharedIndexedFilenames = new Set(
    sharedRaw.split('\n').map(parseIndexLine).filter(Boolean).map(entry => entry.filename)
  );

  const localLines = fs.readFileSync(MEMORY_INDEX, 'utf8').split('\n');
  const appended = [];

  for (const line of localLines) {
    const parsed = parseIndexLine(line);
    if (!parsed) continue; // headers/blanks — destination keeps its own
    if (!isSafeFilename(parsed.filename)) continue; // corrupted/unsafe entry — drop like an orphan
    const srcPath = path.join(MEMORY_DIR, parsed.filename);
    if (!fs.existsSync(srcPath)) continue; // orphaned local entry, skip

    const destName = resolveDestName(srcPath, sharedDir, parsed.filename, sharedFilesOnDisk);
    if (!sharedFilesOnDisk.has(destName)) {
      fs.copyFileSync(srcPath, path.join(sharedDir, destName));
      sharedFilesOnDisk.add(destName);
    }
    // Identical content may already be on disk without an index entry. Keep
    // the file untouched but add its local metadata so it remains discoverable.
    if (!sharedIndexedFilenames.has(destName)) {
      appended.push(`${parsed.prefix}${parsed.name}](${destName})${parsed.rest}`);
      sharedIndexedFilenames.add(destName);
    }
  }

  if (appended.length) {
    const merged = sharedRaw.replace(/\n+$/, '') + '\n' + appended.join('\n') + '\n';
    atomicWriteFileSync(sharedIndexPath, merged);
  } else if (!fs.existsSync(sharedIndexPath)) {
    atomicWriteFileSync(sharedIndexPath, sharedRaw); // truly-empty shared dir, no local entries either
  }
}

// Decides where a local topic file should land in the shared dir. Returns the
// destination filename to use. Content already present under the original or
// canonical -oclm name returns that existing filename so the caller can still
// add a missing shared-index entry without copying the file again.
function resolveDestName(srcPath, sharedDir, filename, sharedFilesOnDisk) {
  const originalDest = path.join(sharedDir, filename);
  if (!fs.existsSync(originalDest)) return filename; // no collision

  if (filesEqual(srcPath, originalDest)) return filename; // already there under the same name

  const suffixed = filename.replace(/\.md$/, '-oclm.md');
  const suffixedDest = path.join(sharedDir, suffixed);
  if (!fs.existsSync(suffixedDest)) return suffixed;
  if (filesEqual(srcPath, suffixedDest)) return suffixed; // already migrated under the canonical suffixed name in a prior run

  // Exceedingly rare: even the suffixed name collides with unrelated content. Bump a counter.
  let n = 2, candidate;
  do {
    candidate = filename.replace(/\.md$/, `-oclm-${n}.md`);
    n++;
  } while (sharedFilesOnDisk.has(candidate));
  return candidate;
}

function filesEqual(pathA, pathB) {
  return fs.readFileSync(pathA, 'utf8') === fs.readFileSync(pathB, 'utf8');
}
