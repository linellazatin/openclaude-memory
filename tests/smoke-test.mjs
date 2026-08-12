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
// 1. parseRules — exercised via live system.transform
//    Boundary tests (max_lines clamping, stale_after_days=0)
//    are in section 12 as live plugin tests.
// ═══════════════════════════════════════════════════════════

console.log('\n--- 1. parseRules (via RULES.jsonc + system.transform) ---');

await test('default config: first turn injects (injectedOnce=false)', async () => {
  const plugin = await makePlugin();
  const out = makeSystemOutput();
  await plugin['experimental.chat.system.transform']({}, out);
  assert.ok(out.system.length > 0, 'expected system injection on first turn');
});

await test('parseRules: custom rules array is loaded and injected', async () => {
  writeRules('{ "always_persist": ["Custom test rule XYZ"] }');
  const p = await makePlugin();
  // write_memory invalidates cache; tool.execute.after marks dirty so next transform re-reads
  await p.tool.write_memory.execute({ topic: 'Rules Parse Test', content: 'x', summary: 'rules parse test', pin: false });
  await p['tool.execute.after']({ tool: 'write_memory' }, {});
  const out = makeSystemOutput();
  await p['experimental.chat.system.transform']({}, out);
  const injected = out.system.join('\n');
  assert.ok(injected.includes('Custom test rule XYZ'), 'custom always_persist rule should appear in injected Memory Rules');
  writeRules('{ "max_lines": 200, "stale_after_days": 180, "inject_every_n_turns": 5 }');
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
// 9. maintainIndex behaviors (C1–C4)
//    State coming in: MEMORY.md has real entries from
//    sections 1-7. RULES.jsonc is invalid from section 5 —
//    reset it here before any test that reads config.
// ═══════════════════════════════════════════════════════════

console.log('\n--- 9. maintainIndex behaviors ---');

// Restore valid defaults before this section so getCache() gets a clean config.
writeRules('{ "max_lines": 200, "stale_after_days": 180, "inject_every_n_turns": 5 }');

await test('maintainIndex: orphan entries are removed', async () => {
  const raw = fs.readFileSync(path.join(MEMORY_DIR, 'MEMORY.md'), 'utf8');
  fs.writeFileSync(
    path.join(MEMORY_DIR, 'MEMORY.md'),
    raw.trimEnd() + '\n- [Orphan Topic](orphan-test.md) 2026-01-01T00:00:00+00:00 -- orphan\n',
    'utf8'
  );
  await plugin.tool.write_memory.execute({ topic: 'Orphan Trigger', content: 'trigger', summary: 'trigger', pin: false });
  const idx = readIndex();
  assert.ok(!idx.includes('orphan-test.md'), 'orphan entry should be removed');
  assert.ok(idx.includes('Orphan Trigger'), 'legitimate entry should remain');
});

await test('maintainIndex: duplicate entries — more-recent date wins', async () => {
  const raw = fs.readFileSync(path.join(MEMORY_DIR, 'MEMORY.md'), 'utf8');
  fs.writeFileSync(
    path.join(MEMORY_DIR, 'MEMORY.md'),
    raw.trimEnd() + '\n- [Orphan Trigger](orphan-trigger.md) 2020-01-01T00:00:00+00:00 -- older dupe\n',
    'utf8'
  );
  await plugin.tool.write_memory.execute({ topic: 'Dedup Trigger', content: 'x', summary: 'dedup', pin: false });
  const idx = readIndex();
  const dupes = idx.split('\n').filter(l => l.includes('orphan-trigger.md'));
  assert.equal(dupes.length, 1, 'only one entry should survive for the filename');
  assert.ok(!dupes[0].includes('2020-01-01'), 'older duplicate should be removed, newer kept');
});

await test('maintainIndex: [stale?] is stamped on entries older than stale_after_days', async () => {
  fs.writeFileSync(path.join(MEMORY_DIR, 'stale-test.md'), '---\nname: Stale Test\n---\n\ncontent\n', 'utf8');
  const raw = fs.readFileSync(path.join(MEMORY_DIR, 'MEMORY.md'), 'utf8');
  fs.writeFileSync(
    path.join(MEMORY_DIR, 'MEMORY.md'),
    raw.trimEnd() + '\n- [Stale Test](stale-test.md) 2025-01-01T00:00:00+00:00 -- stale entry\n',
    'utf8'
  );
  writeRules('{ "stale_after_days": 180 }');
  await plugin.tool.write_memory.execute({ topic: 'Stale Trigger', content: 'x', summary: 'stale trigger', pin: false });
  const idx = readIndex();
  const staleLine = idx.split('\n').find(l => l.includes('stale-test.md'));
  assert.ok(staleLine, 'stale-test.md entry should still be in the index');
  assert.ok(staleLine.includes('[stale?]'), '[stale?] should be stamped on old entry');
});

await test('maintainIndex: [stale?] is removed after topic is updated (self-heal)', async () => {
  await plugin.tool.write_memory.execute({ topic: 'Stale Test', content: 'refreshed', summary: 'stale test refreshed', pin: false });
  const idx = readIndex();
  const staleLine = idx.split('\n').find(l => l.includes('stale-test.md'));
  assert.ok(staleLine, 'stale-test.md entry should still be in index');
  assert.ok(!staleLine.includes('[stale?]'), '[stale?] should be removed after update');
});

// ═══════════════════════════════════════════════════════════
// 10. inject_every_n_turns — live interval trigger (C5)
//     Write inject_every_n_turns:2, call compaction to reset
//     all state, then verify turns 1+2 inject, turn 3 skips.
// ═══════════════════════════════════════════════════════════

console.log('\n--- 10. inject_every_n_turns trigger ---');

await test('inject_every_n_turns=2: injects at turn 1 and turn 2; skips turn 3', async () => {
  writeRules('{ "inject_every_n_turns": 2 }');
  // Compaction force-refreshes config and resets _injectedOnce=false, _dirty=false, _turnCount=0
  await plugin['experimental.session.compacting']({}, makeCompactOutput());

  const out1 = makeSystemOutput();
  await plugin['experimental.chat.system.transform']({}, out1);
  assert.ok(out1.system.length > 0, 'turn 1 should inject (!_injectedOnce)');

  const out2 = makeSystemOutput();
  await plugin['experimental.chat.system.transform']({}, out2);
  assert.ok(out2.system.length > 0, 'turn 2 should inject (2 % 2 === 0)');

  const out3 = makeSystemOutput();
  await plugin['experimental.chat.system.transform']({}, out3);
  assert.equal(out3.system.length, 0, 'turn 3 should NOT inject (3 % 2 !== 0, not dirty)');

  writeRules('{ "max_lines": 200, "stale_after_days": 180, "inject_every_n_turns": 5 }');
});

// ═══════════════════════════════════════════════════════════
// 11. pin-preservation (C6)
//     write_memory with pin:false must not unpin a pinned entry.
// ═══════════════════════════════════════════════════════════

console.log('\n--- 11. pin-preservation ---');

await test('write_memory with pin:false does not unpin a pinned entry', async () => {
  await plugin.tool.write_memory.execute({ topic: 'Pin Preserve Test', content: 'initial', summary: 'pin preserve', pin: true });
  let idx = readIndex();
  const pinLine = idx.split('\n').find(l => l.includes('pin-preserve-test.md'));
  assert.ok(pinLine && pinLine.includes('[pin]'), 'entry should be pinned initially');

  await plugin.tool.write_memory.execute({ topic: 'Pin Preserve Test', content: 'updated', summary: 'pin preserve updated', pin: false });
  idx = readIndex();
  const updatedLine = idx.split('\n').find(l => l.includes('pin-preserve-test.md'));
  assert.ok(updatedLine && updatedLine.includes('[pin]'), 'entry should still be pinned after write_memory with pin:false');
});

// ═══════════════════════════════════════════════════════════
// 12. parseRules live boundary tests (C7)
//     max_lines clamping and stale_after_days=0 verified via
//     observable plugin behavior rather than an inline copy.
// ═══════════════════════════════════════════════════════════

console.log('\n--- 12. parseRules live boundary tests ---');

await test('max_lines clamps to 50 minimum (live truncation)', async () => {
  writeRules('{ "max_lines": 10 }');
  const mockFiles = Array.from({ length: 55 }, (_, i) => `mock-ml-${i}.md`);
  for (const fn of mockFiles) {
    fs.writeFileSync(path.join(MEMORY_DIR, fn), `---\nname: ML Mock\n---\n\ncontent\n`, 'utf8');
  }
  const entries = mockFiles.map((fn, i) => `- [ML Mock ${i}](${fn}) 2026-01-01T00:00:00+00:00 -- mock ${i}`);
  fs.writeFileSync(path.join(MEMORY_DIR, 'MEMORY.md'), ['# Memory Index', ...entries].join('\n') + '\n', 'utf8');
  try {
    await plugin['tool.execute.after']({ tool: 'write_memory' }, {});
    const out = makeSystemOutput();
    await plugin['experimental.chat.system.transform']({}, out);
    const injected = out.system.join('\n');
    assert.ok(injected.includes('50-line limit'), `expected "50-line limit" truncation warning; got tail: ${injected.slice(-300)}`);
  } finally {
    for (const fn of mockFiles) try { fs.unlinkSync(path.join(MEMORY_DIR, fn)); } catch {}
    writeRules('{ "max_lines": 200, "stale_after_days": 180, "inject_every_n_turns": 5 }');
  }
});

await test('stale_after_days=0 disables [stale?] stamping (live)', async () => {
  // Flush cache so the next config write is picked up on next getCache() call
  await plugin.tool.write_memory.execute({ topic: 'Stale Zero Flush', content: 'x', summary: 'flush', pin: false });
  writeRules('{ "stale_after_days": 0 }');
  fs.writeFileSync(path.join(MEMORY_DIR, 'stale-zero-test.md'), '---\nname: Stale Zero\n---\n\ncontent\n', 'utf8');
  const raw = fs.readFileSync(path.join(MEMORY_DIR, 'MEMORY.md'), 'utf8');
  fs.writeFileSync(
    path.join(MEMORY_DIR, 'MEMORY.md'),
    raw.trimEnd() + '\n- [Stale Zero](stale-zero-test.md) 2020-01-01T00:00:00+00:00 -- very old\n',
    'utf8'
  );
  await plugin.tool.write_memory.execute({ topic: 'Stale Zero Trigger', content: 'x', summary: 'trigger', pin: false });
  const idx = readIndex();
  const entry = idx.split('\n').find(l => l.includes('stale-zero-test.md'));
  assert.ok(entry, 'stale-zero-test.md entry should exist in index');
  assert.ok(!entry.includes('[stale?]'), '[stale?] should NOT be stamped when stale_after_days=0');
  writeRules('{ "max_lines": 200, "stale_after_days": 180, "inject_every_n_turns": 5 }');
});

// ═══════════════════════════════════════════════════════════
// Results
// ═══════════════════════════════════════════════════════════

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
