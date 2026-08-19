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
// attempt retries on the next process start.
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
const LOCK_ACQUIRE_TIMEOUT_MS = 500;
const LOCK_POLL_INTERVAL_MS = 25;

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
// index lines. wx create fails if the lock already exists; a lock older than
// LOCK_STALE_MS is assumed abandoned (crashed holder) and reclaimed.
// If contention persists past LOCK_ACQUIRE_TIMEOUT_MS, proceeds without the
// lock rather than hanging indefinitely — best-effort, not a hard guarantee.
export async function acquireLock(memDir) {
  ensureMemoryDir(memDir);
  const lockPath = path.join(memDir, '.lock');
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.closeSync(fd);
      return lockPath;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          try { fs.unlinkSync(lockPath); } catch {}
          continue; // retry acquire immediately after reclaiming
        }
      } catch {}
      if (Date.now() > deadline) return null;
      await sleep(LOCK_POLL_INTERVAL_MS);
    }
  }
}

export function releaseLock(lockPath) {
  if (!lockPath) return;
  try { fs.unlinkSync(lockPath); } catch {}
}

export const stripJsonc = raw => raw.replace(/\/\/[^\n]*/g, '').replace(/,\s*([}\]])/g, '$1');

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
  } catch {
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
  } catch {
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
    const lockPath = await acquireLock(sharedDir);
    try {
      mergeLocalIntoSharedDir(sharedDir);
    } finally {
      releaseLock(lockPath);
    }
    fs.writeFileSync(CARRY_OVER_SENTINEL, '');
  } catch {
    // best-effort — carry-over failure should never break normal operation;
    // sentinel intentionally not written on failure so a retry can happen
    // on the next process start
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

  const localLines = fs.readFileSync(MEMORY_INDEX, 'utf8').split('\n');
  const appended = [];

  for (const line of localLines) {
    const parsed = parseIndexLine(line);
    if (!parsed) continue; // headers/blanks — destination keeps its own
    const srcPath = path.join(MEMORY_DIR, parsed.filename);
    if (!fs.existsSync(srcPath)) continue; // orphaned local entry, skip

    const destName = resolveDestName(srcPath, sharedDir, parsed.filename, sharedFilesOnDisk);
    if (destName === null) continue; // identical content already present under some name — nothing to do

    fs.copyFileSync(srcPath, path.join(sharedDir, destName));
    sharedFilesOnDisk.add(destName);
    appended.push(`${parsed.prefix}${parsed.name}](${destName})${parsed.rest}`);
  }

  if (appended.length) {
    const merged = sharedRaw.replace(/\n+$/, '') + '\n' + appended.join('\n') + '\n';
    atomicWriteFileSync(sharedIndexPath, merged);
  } else if (!fs.existsSync(sharedIndexPath)) {
    atomicWriteFileSync(sharedIndexPath, sharedRaw); // truly-empty shared dir, no local entries either
  }
}

// Decides where a local topic file should land in the shared dir. Returns the
// destination filename to use, or null if nothing needs to be written
// (content already present under the original name or the canonical -oclm name).
function resolveDestName(srcPath, sharedDir, filename, sharedFilesOnDisk) {
  const originalDest = path.join(sharedDir, filename);
  if (!fs.existsSync(originalDest)) return filename; // no collision

  if (filesEqual(srcPath, originalDest)) return null; // already there under the same name

  const suffixed = filename.replace(/\.md$/, '-oclm.md');
  const suffixedDest = path.join(sharedDir, suffixed);
  if (!fs.existsSync(suffixedDest)) return suffixed;
  if (filesEqual(srcPath, suffixedDest)) return null; // already migrated under the canonical suffixed name in a prior run

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
