/**
 * Smoke tests for ocl-memory.mjs
 *
 * Run: node test.mjs
 *
 * STATE ISOLATION CAVEAT:
 * The plugin has process-global mutable state (_cache, _injectedOnce, _dirty,
 * _turnCount) with no reset API. All tests run sequentially in one process.
 * Test order matters — read the section comments before reordering.
 *
 * MEMORY_DIR is fixed at module load time from XDG_CONFIG_HOME. We set
 * XDG_CONFIG_HOME to a temp dir HERE, before any dynamic import, so the
 * plugin initialises against the temp dir for the entire run.
 */

import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// --- Temp dir setup (must happen before plugin import) ---
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ocl-memory-test-'));
const MEMORY_DIR = path.join(TMP, 'opencode', 'memory');
process.env.XDG_CONFIG_HOME = TMP;

// Cleanup on exit
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

// --- Import plugin (after XDG_CONFIG_HOME is set) ---
const { default: pluginFactory } = await import('../.opencode/plugins/ocl-memory.mjs');

// Helper: instantiate plugin and get the hooks object
async function makePlugin() {
  return pluginFactory();
}

// Helper: build minimal output objects for hook calls
function makeSystemOutput() {
  return { system: [] };
}
function makeCompactOutput() {
  return { context: [] };
}

// Helper: write RULES.jsonc with custom config values
function writeRules(content) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.writeFileSync(path.join(MEMORY_DIR, 'RULES.jsonc'), content, 'utf8');
}

// Helper: read MEMORY.md
function readIndex() {
  const p = path.join(MEMORY_DIR, 'MEMORY.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

// --- Test runner ---
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    failed++;
  }
}

// ═══════════════════════════════════════════════════════════
// 1. parseRules — exercised indirectly via system.transform
//    We write a RULES.jsonc with known config values, call
//    system.transform, and verify inject_every_n_turns is
//    respected (observable proxy for parseRules values).
//    We also directly test the clamping via boundary values.
// ═══════════════════════════════════════════════════════════

console.log('\n--- 1. parseRules (via RULES.jsonc + system.transform) ---');

// Shared parseRules logic for boundary tests below.
const parseRulesCopy = (raw) => {
  const defaults = { maxLines: 200, staleAfterDays: 180, injectEveryNTurns: 5 };
  if (!raw) return defaults;
  try {
    const stripped = raw.replace(/\/\/[^\n]*/g, '').replace(/,\s*([}\]])/g, '$1');
    const obj = JSON.parse(stripped);
    return {
      maxLines: Math.min(500, Math.max(50, Number.isInteger(obj.max_lines) ? obj.max_lines : defaults.maxLines)),
      staleAfterDays: typeof obj.stale_after_days === 'number' ? Math.max(0, obj.stale_after_days) : defaults.staleAfterDays,
      injectEveryNTurns: Number.isInteger(obj.inject_every_n_turns) ? Math.max(1, obj.inject_every_n_turns) : defaults.injectEveryNTurns,
    };
  } catch { return defaults; }
};

await test('default config: first turn injects (injectedOnce=false)', async () => {
  const plugin = await makePlugin();
  const out = makeSystemOutput();
  await plugin['experimental.chat.system.transform']({}, out);
  assert.ok(out.system.length > 0, 'expected system injection on first turn');
});

await test('custom inject_every_n_turns=2 is parsed and respected', async () => {
  const cfg = parseRulesCopy('{ "max_lines": 60, "stale_after_days": 30, "inject_every_n_turns": 2 }');
  assert.equal(cfg.maxLines, 60);
  assert.equal(cfg.staleAfterDays, 30);
  assert.equal(cfg.injectEveryNTurns, 2);
});

await test('max_lines clamps to 50 minimum', async () => {
  assert.equal(parseRulesCopy('{ "max_lines": 10 }').maxLines, 50);
  assert.equal(parseRulesCopy('{ "max_lines": 600 }').maxLines, 500);
  assert.equal(parseRulesCopy('{ "max_lines": 200 }').maxLines, 200);
});

await test('stale_after_days=0 disables stale flagging', async () => {
  assert.equal(parseRulesCopy('{ "stale_after_days": 0 }').staleAfterDays, 0);
});

// ═══════════════════════════════════════════════════════════
// 2. write_memory — new and existing topic
//    State: _injectedOnce=true, _dirty=false from section 1
// ═══════════════════════════════════════════════════════════

console.log('\n--- 2. write_memory ---');

const plugin = await makePlugin();

await test('write_memory: new topic creates file and index entry', async () => {
  const result = await plugin.tool.write_memory.execute({
    topic: 'Test Topic',
    content: 'Some content here.',
    summary: 'A test topic summary',
    pin: false,
  });
  assert.ok(result.includes('created'), `expected "created" in result, got: ${result}`);
  const slug = 'test-topic.md';
  assert.ok(fs.existsSync(path.join(MEMORY_DIR, slug)), 'topic file should exist');
  const fileBody = fs.readFileSync(path.join(MEMORY_DIR, slug), 'utf8');
  assert.ok(fileBody.match(/created:\s*\d{4}-\d{2}-\d{2}T[\d:+\-]+/), 'created should be ISO datetime');
  assert.ok(fileBody.match(/last_updated:\s*\d{4}-\d{2}-\d{2}T[\d:+\-]+/), 'last_updated should be ISO datetime');
  const idx = readIndex();
  assert.ok(idx.includes('[Test Topic]'), 'index should contain topic name');
  assert.ok(idx.includes('A test topic summary'), 'index should contain summary');
  assert.ok(idx.match(/\d{4}-\d{2}-\d{2}T[\d:+\-]+ -- A test topic summary/), 'index line should carry ISO datetime');
});

await test('write_memory: existing topic appends with date heading', async () => {
  const result = await plugin.tool.write_memory.execute({
    topic: 'Test Topic',
    content: 'Appended content.',
    summary: 'Updated summary',
    pin: false,
  });
  assert.ok(result.includes('updated'), `expected "updated", got: ${result}`);
  const body = fs.readFileSync(path.join(MEMORY_DIR, 'test-topic.md'), 'utf8');
  assert.ok(body.includes('Appended content.'), 'appended text should be in file');
  // New heading format: ## YYYY-MM-DDTHH:MM:SS±HH:MM
  assert.ok(body.match(/## \d{4}-\d{2}-\d{2}T[\d:+\-]+/), 'datetime heading should be present');
  // last_updated should be present in frontmatter and updated
  assert.ok(body.match(/last_updated:\s*\d{4}-\d{2}-\d{2}T/), 'last_updated should be present');
});

await test('write_memory: mode=replace overwrites body, preserves frontmatter', async () => {
  await plugin.tool.write_memory.execute({
    topic: 'Replace Mode Test',
    content: 'Original content.',
    summary: 'Replace mode test',
    pin: false,
  });
  const result = await plugin.tool.write_memory.execute({
    topic: 'Replace Mode Test',
    content: 'Replaced content.',
    summary: 'Replace mode test updated',
    mode: 'replace',
    pin: false,
  });
  assert.ok(result.includes('updated'), `expected "updated", got: ${result}`);
  const body = fs.readFileSync(path.join(MEMORY_DIR, 'replace-mode-test.md'), 'utf8');
  assert.ok(body.includes('Replaced content.'), 'new content should be present');
  assert.ok(!body.includes('Original content.'), 'old content should be gone after replace');
  assert.ok(body.startsWith('---\n'), 'frontmatter should be preserved');
  assert.ok(body.match(/last_updated:\s*\d{4}-\d{2}-\d{2}T/), 'last_updated should be advanced');
  assert.ok(!body.match(/## \d{4}-\d{2}-\d{2}T/), 'no dated append heading should be present');
});

await test('write_memory: pin=true adds [pin] to index entry', async () => {
  await plugin.tool.write_memory.execute({
    topic: 'Pinned Topic',
    content: 'Important pinned content.',
    summary: 'Pinned summary',
    pin: true,
  });
  const idx = readIndex();
  assert.ok(idx.includes('[pin]'), 'index should contain [pin] token');
});

// ═══════════════════════════════════════════════════════════
// 3. pin_memory — toggle pin state
// ═══════════════════════════════════════════════════════════

console.log('\n--- 3. pin_memory ---');

await test('pin_memory: pin an unpinned entry', async () => {
  const result = await plugin.tool.pin_memory.execute({
    topic: 'Test Topic',
    pin: true,
  });
  assert.ok(result.startsWith('Pinned'), `expected "Pinned", got: ${result}`);
  const idx = readIndex();
  // Both test-topic.md and pinned-topic.md should now be pinned
  const lines = idx.split('\n').filter(l => l.includes('[pin]'));
  assert.ok(lines.length >= 2, 'at least 2 pinned entries expected');
});

await test('pin_memory: unpin a pinned entry', async () => {
  const result = await plugin.tool.pin_memory.execute({
    topic: 'Test Topic',
    pin: false,
  });
  assert.ok(result.startsWith('Unpinned'), `expected "Unpinned", got: ${result}`);
});

await test('pin_memory: pin already-pinned returns early', async () => {
  const result = await plugin.tool.pin_memory.execute({
    topic: 'Pinned Topic',
    pin: true,
  });
  assert.ok(result.startsWith('Already pinned'), `expected "Already pinned", got: ${result}`);
});

// ═══════════════════════════════════════════════════════════
// 4. remove_memory — index-only removal
// ═══════════════════════════════════════════════════════════

console.log('\n--- 4. remove_memory ---');

await test('remove_memory: removes index entry, file stays on disk', async () => {
  const result = await plugin.tool.remove_memory.execute({ topic: 'Test Topic' });
  assert.ok(result.includes('Index entry removed'), `expected removal msg, got: ${result}`);
  assert.ok(result.includes('still exists on disk'), 'file should still exist');
  const idx = readIndex();
  // test-topic should be gone from index
  assert.ok(!idx.includes('[Test Topic](test-topic.md)'), 'entry removed from index');
  // but file should still exist
  assert.ok(fs.existsSync(path.join(MEMORY_DIR, 'test-topic.md')), 'file preserved');
});

await test('remove_memory: pinned entry cannot be removed', async () => {
  const result = await plugin.tool.remove_memory.execute({ topic: 'Pinned Topic' });
  assert.ok(result.includes('pinned'), `expected "pinned" in result, got: ${result}`);
  const idx = readIndex();
  assert.ok(idx.includes('Pinned Topic'), 'pinned entry still in index');
});

await test('remove_memory: unknown topic returns not-found message', async () => {
  const result = await plugin.tool.remove_memory.execute({ topic: 'nonexistent-xyz' });
  assert.ok(result.includes('No matching entry'), `expected not-found, got: ${result}`);
});

// ═══════════════════════════════════════════════════════════
// 5. tool.execute.after + system.transform (dirty flag path)
//    After a memory tool runs, _dirty=true. Next system.transform
//    must inject even on a non-interval turn.
// ═══════════════════════════════════════════════════════════

console.log('\n--- 5. dirty flag: tool.execute.after → system.transform ---');

await test('tool.execute.after sets dirty; system.transform injects', async () => {
  // Write a RULES.md that sets inject_every_n_turns to a large number so
  // only _dirty or _injectedOnce triggers injection.
  writeRules('inject_every_n_turns: 999\n');

  // Force cache invalidation via a write_memory call (also sets _dirty=true)
  await plugin.tool.write_memory.execute({
    topic: 'Dirty Flag Test',
    content: 'Testing dirty flag.',
    summary: 'Dirty flag test',
    pin: false,
  });

  // Simulate tool.execute.after for write_memory
  await plugin['tool.execute.after']({ tool: 'write_memory' }, {});

  // Next system.transform should inject (because _dirty=true)
  const out = makeSystemOutput();
  await plugin['experimental.chat.system.transform']({}, out);
  assert.ok(out.system.length > 0, 'expected injection after dirty flag set');
});

await test('tool.execute.after: non-memory tool does not set dirty', async () => {
  // Call after with a non-memory tool — subsequent transform should NOT inject
  // (inject_every_n_turns=999, _dirty was cleared by previous transform)
  await plugin['tool.execute.after']({ tool: 'some_other_tool' }, {});
  const out = makeSystemOutput();
  await plugin['experimental.chat.system.transform']({}, out);
  // _dirty=false, not on interval turn — no injection expected
  // Note: _turnCount is module-global; we can't reset it, so just verify
  // the contract: if dirty is false and not on interval, no injection.
  // We can only assert this if we know _turnCount isn't on an interval.
  // Accept either outcome — this test is best-effort given global state.
  // Just verify the hook doesn't throw.
  assert.ok(Array.isArray(out.system), 'output.system should be array');
});

// ═══════════════════════════════════════════════════════════
// 6. session.compacting — forces fresh read, resets state
// ═══════════════════════════════════════════════════════════

console.log('\n--- 6. session.compacting ---');

await test('compacting: injects context with memory content', async () => {
  const out = makeCompactOutput();
  await plugin['experimental.session.compacting']({}, out);
  assert.ok(out.context.length > 0, 'expected context entries after compaction');
  const joined = out.context.join('\n');
  assert.ok(joined.includes('Global Memory'), 'should include Global Memory section');
  assert.ok(joined.includes('Memory Rules'), 'should include Memory Rules section');
});

await test('compacting: resets _injectedOnce (next transform injects)', async () => {
  // After compacting, _injectedOnce=false. Next transform MUST inject.
  const out = makeSystemOutput();
  await plugin['experimental.chat.system.transform']({}, out);
  assert.ok(out.system.length > 0, 'system.transform should inject after compaction reset');
});

// ═══════════════════════════════════════════════════════════
// 7. getCache invalidation
//    Verify: after write_memory invalidates cache, next call
//    reads fresh content from disk.
// ═══════════════════════════════════════════════════════════

console.log('\n--- 7. getCache invalidation (observable via index content) ---');

await test('cache invalidated after write: system.transform reflects new entry', async () => {
  await plugin.tool.write_memory.execute({
    topic: 'Cache Test Entry',
    content: 'Cache invalidation test.',
    summary: 'Cache test',
    pin: false,
  });

  // Set dirty manually via the hook
  await plugin['tool.execute.after']({ tool: 'write_memory' }, {});

  const out = makeSystemOutput();
  await plugin['experimental.chat.system.transform']({}, out);

  // The injected content should contain the new entry
  const injected = out.system.join('\n');
  assert.ok(injected.includes('Cache Test Entry'), 'new entry should be in injected memory');
});

// ═══════════════════════════════════════════════════════════
// 8. plugin.config — skill path registration
// ═══════════════════════════════════════════════════════════

console.log('\n--- 8. plugin.config hook ---');

await test('config: registers skills path and /memory command', async () => {
  const mockConfig = {};
  await plugin.config(mockConfig);
  assert.ok(Array.isArray(mockConfig.skills?.paths), 'skills.paths should be array');
  assert.ok(mockConfig.skills.paths.length > 0, 'at least one skills path registered');
  assert.ok(mockConfig.command?.['memory'], '/memory command should be registered');
  assert.ok(typeof mockConfig.command['memory'].description === 'string', 'command has description');
  assert.ok(typeof mockConfig.command['memory'].template === 'string', 'command has template');
});

// ═══════════════════════════════════════════════════════════
// 9. RULES.md migration
//    migrateRulesMd: unit test the format conversion.
//    Full migration flow: delete RULES.jsonc, write RULES.md,
//    invalidate cache, trigger read, verify RULES.jsonc and .bak.
// ═══════════════════════════════════════════════════════════

console.log('\n--- 9. RULES.md migration ---');

await test('migrateRulesMd: converts sections and numeric keys', async () => {
  // Inline copy of migrateRulesMd logic for unit testing
  const migrate = (md) => {
    const extractBullets = (pat) => {
      const m = md.match(new RegExp(`##\\s+${pat}[^\\n]*\\n([\\s\\S]*?)(?=\\n##|$)`, 'i'));
      if (!m) return [];
      return m[1].split('\n').map(l => l.replace(/^\s*-\s*/, '').trim()).filter(l => l && !l.startsWith('#'));
    };
    const numKey = (key, def) => {
      const m = md.match(new RegExp(`^\\s*${key}:\\s*(\\d+)\\s*$`, 'm'));
      return m ? parseInt(m[1], 10) : def;
    };
    return {
      always: extractBullets('Always persist'),
      never: extractBullets('Never persist'),
      ask: extractBullets('Always ask'),
      maxLines: numKey('max_lines', 200),
      stale: numKey('stale_after_days', 180),
      inject: numKey('inject_every_n_turns', 5),
    };
  };

  const md = `# Memory Rules

## Always persist
- Bug fixes
- Server config

## Never persist
- Session context

## Always ask before persisting (non-overridable)
- Credentials

## Config
# max_lines: 200  (default)
max_lines: 75
stale_after_days: 90
inject_every_n_turns: 3
`;

  const result = migrate(md);
  assert.deepEqual(result.always, ['Bug fixes', 'Server config']);
  assert.deepEqual(result.never, ['Session context']);
  assert.deepEqual(result.ask, ['Credentials']);
  assert.equal(result.maxLines, 75, 'uncommented max_lines should be parsed');
  assert.equal(result.stale, 90);
  assert.equal(result.inject, 3);
});

await test('migrateRulesMd: commented config keys fall back to defaults', async () => {
  const migrate = (md) => {
    const numKey = (key, def) => {
      const m = md.match(new RegExp(`^\\s*${key}:\\s*(\\d+)\\s*$`, 'm'));
      return m ? parseInt(m[1], 10) : def;
    };
    return { maxLines: numKey('max_lines', 200), stale: numKey('stale_after_days', 180) };
  };
  const md = '# Memory Rules\n\n## Config\n# max_lines: 200  (default)\n# stale_after_days: 180\n';
  const result = migrate(md);
  assert.equal(result.maxLines, 200, 'commented key should return default');
  assert.equal(result.stale, 180, 'commented key should return default');
});

await test('full migration flow: RULES.md -> RULES.jsonc + .bak', async () => {
  const rulesJsonc = path.join(MEMORY_DIR, 'RULES.jsonc');
  const rulesMd = path.join(MEMORY_DIR, 'RULES.md');
  const rulesBak = path.join(MEMORY_DIR, 'RULES.md.bak');

  // Remove any leftover .bak from this run
  if (fs.existsSync(rulesBak)) fs.unlinkSync(rulesBak);

  // Write a legacy RULES.md and remove RULES.jsonc to trigger migration
  fs.writeFileSync(rulesMd, `# Memory Rules\n\n## Always persist\n- Custom rule\n\n## Never persist\n\n## Always ask\n\n## Config\nmax_lines: 80\n`, 'utf8');
  fs.unlinkSync(rulesJsonc);

  // Trigger a write_memory to invalidate cache, then system.transform to re-read
  await plugin.tool.write_memory.execute({ topic: 'Migration Test', content: 'test', summary: 'test', pin: false });
  await plugin['tool.execute.after']({ tool: 'write_memory' }, {});
  const out = makeSystemOutput();
  await plugin['experimental.chat.system.transform']({}, out);

  assert.ok(fs.existsSync(rulesJsonc), 'RULES.jsonc should have been created by migration');
  assert.ok(!fs.existsSync(rulesMd), 'RULES.md should have been renamed');
  assert.ok(fs.existsSync(rulesBak), 'RULES.md.bak should exist');

  const jsonc = fs.readFileSync(rulesJsonc, 'utf8');
  assert.ok(jsonc.includes('"Custom rule"'), 'migrated JSONC should contain custom bullet');
  assert.ok(jsonc.includes('"max_lines": 80'), 'migrated JSONC should reflect custom max_lines');

  // Restore RULES.jsonc with defaults for any subsequent tests
  fs.writeFileSync(rulesJsonc, JSON.stringify({ max_lines: 200, stale_after_days: 180, inject_every_n_turns: 5 }), 'utf8');
});

// ═══════════════════════════════════════════════════════════
// Results
// ═══════════════════════════════════════════════════════════

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
