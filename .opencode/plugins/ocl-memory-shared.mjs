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
export const MEMORY_CONFIG_LEGACY = path.join(MEMORY_DIR, 'RULES.jsonc'); // pre-0.6.0 location, fallback only

// Shared cross-tool memory store — opt-in via "shared_dir": true in memory.jsonc.
// Root is overridable via OCL_SHARED_MEMORY_HOME for tests; real installs use the home dir.
export const SHARED_MEMORY_DIR = path.join(
  process.env.OCL_SHARED_MEMORY_HOME || os.homedir(),
  '.agents', 'memory'
);

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

// One-way, non-destructive carry-over when shared_dir is first enabled.
// Copies (never moves) local memory files into the shared dir. Runs at most
// once per process. Toggling shared_dir off then on again does not re-run
// this or reconcile drift — deliberate, matching openpi-memory's stance (see
// AGENTS.md quirk).
export function maybeCarryOverToSharedDir(config) {
  if (!config.sharedDir || _carryOverChecked) return;
  _carryOverChecked = true;
  try {
    const sharedDir = SHARED_MEMORY_DIR;
    const sharedIndex = path.join(sharedDir, 'MEMORY.md');
    if (fs.existsSync(sharedIndex)) return; // shared dir already has content
    if (!fs.existsSync(MEMORY_INDEX)) return; // nothing local to carry over
    // Skip transient/internal files; originals stay in MEMORY_DIR untouched
    // (this is a copy, not a move) so no separate backup dir is needed.
    const skip = new Set(['.invalidate', '.lock']);
    const entries = fs.readdirSync(MEMORY_DIR).filter(e => !skip.has(e));

    fs.mkdirSync(sharedDir, { recursive: true });
    for (const entry of entries) {
      const srcPath = path.join(MEMORY_DIR, entry);
      if (fs.statSync(srcPath).isDirectory()) continue;
      fs.copyFileSync(srcPath, path.join(sharedDir, entry));
    }
  } catch {
    // best-effort — carry-over failure should never break normal operation
  }
}
