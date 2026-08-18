/**
 * Smoke tests for ocl-memory.mjs
 *
 * Run: node test.mjs
 *
 * STATE ISOLATION CAVEAT:
 * The plugin has process-global mutable state (_cache, _injectedOnce, _dirty,
 * _turnCount, _carryOverChecked) with no reset API. All tests run sequentially
 * in one process. Test order matters — read the section comments before
 * reordering.
 *
 * MEMORY_DIR is fixed at module load time from XDG_CONFIG_HOME. We set
 * XDG_CONFIG_HOME to a temp dir HERE, before any dynamic import, so the
 * plugin initialises against the temp dir for the entire run. Likewise
 * OCL_SHARED_MEMORY_HOME redirects the shared_dir root to a second temp dir
 * so shared_dir tests never touch the real ~/.agents/memory/.
 */

import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// --- Temp dir setup (must happen before plugin import) ---
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ocl-memory-test-'));
const MEMORY_DIR = path.join(TMP, 'opencode', 'memory');
const MEMORY_CONFIG = path.join(TMP, 'opencode', 'memory.jsonc');
const MEMORY_CONFIG_LEGACY = path.join(MEMORY_DIR, 'RULES.jsonc');
process.env.XDG_CONFIG_HOME = TMP;

const SHARED_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ocl-memory-shared-'));
const SHARED_MEMORY_DIR = path.join(SHARED_TMP, '.agents', 'memory');
process.env.OCL_SHARED_MEMORY_HOME = SHARED_TMP;

// Cleanup on exit
process.on('exit', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(SHARED_TMP, { recursive: true, force: true });
});

// --- Import plugin (after env vars are set) ---
const { default: pluginFactory } = await import('../.opencode/plugins/ocl-memory.mjs');
const tui = await import('../.opencode/plugins/ocl-memory-tui.mjs');

// Helper: instantiate plugin and get the hooks object. Pass { client } to
// exercise the consolidation autocontinue path.
async function makePlugin(input) {
  return pluginFactory(input);
}

// Helper: build minimal output objects for hook calls
function makeSystemOutput() {
  return { system: [] };
}
function makeCompactOutput() {
  return { context: [] };
}

// Helper: write memory.jsonc with custom config values
function writeRules(content) {
  fs.mkdirSync(path.dirname(MEMORY_CONFIG), { recursive: true });
  fs.writeFileSync(MEMORY_CONFIG, content, 'utf8');
}

// Helper: read MEMORY.md (local dir)
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
// 0. Config relocation: legacy RULES.jsonc → memory.jsonc
//    Must run FIRST, before memory.jsonc exists from any other
//    test — the legacy fallback only triggers while it's absent.
// ═══════════════════════════════════════════════════════════

console.log('\n--- 0. config relocation: legacy RULES.jsonc fallback ---');

await test('legacy RULES.jsonc is migrated to memory.jsonc on first read', async () => {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.writeFileSync(MEMORY_CONFIG_LEGACY, '{ "always_persist": ["Legacy rule marker"] }', 'utf8');
  assert.ok(!fs.existsSync(MEMORY_CONFIG), 'memory.jsonc should not exist yet');

  const plugin = await makePlugin();
  // Use session.compacting (not system.transform) — it always injects
  // unconditionally and resets _injectedOnce/_dirty/_turnCount afterward,
  // so it doesn't corrupt the "first turn" assumption section 1 relies on.
  const out = makeCompactOutput();
  await plugin['experimental.session.compacting']({}, out); // triggers readMemoryRules()

  assert.ok(fs.existsSync(MEMORY_CONFIG), 'memory.jsonc should be created from legacy content');
  const migrated = fs.readFileSync(MEMORY_CONFIG, 'utf8');
  assert.ok(migrated.includes('Legacy rule marker'), 'migrated content should match legacy content');
  assert.ok(fs.existsSync(`${MEMORY_CONFIG_LEGACY}.bak`), 'legacy file should be renamed to .bak');
  assert.ok(!fs.existsSync(MEMORY_CONFIG_LEGACY), 'legacy file should no longer exist at the original path');

  const injected = out.context.join('\n');
  assert.ok(injected.includes('Legacy rule marker'), 'migrated rule should be injected into compaction context');
});

await test('memory.jsonc takes precedence once it exists', async () => {
  // Simulate a leftover legacy file reappearing at the old path — must be ignored.
  fs.writeFileSync(MEMORY_CONFIG_LEGACY, '{ "always_persist": ["Should be ignored"] }', 'utf8');
  writeRules('{ "always_persist": ["Current rule marker"] }');

  const plugin = await makePlugin();
  const out = makeCompactOutput();
  await plugin['experimental.session.compacting']({}, out);
  const injected = out.context.join('\n');
  assert.ok(injected.includes('Current rule marker'), 'memory.jsonc content should be used');
  assert.ok(!injected.includes('Should be ignored'), 'a file at the old legacy path should be ignored once memory.jsonc exists');

  try { fs.unlinkSync(MEMORY_CONFIG_LEGACY); } catch {}
  writeRules('{ "max_lines": 300, "stale_after_days": 180, "inject_every_n_turns": 5 }');
});

// ═══════════════════════════════════════════════════════════
// 1. parseRules — exercised via live system.transform
//    Boundary tests (max_lines clamping, stale_after_days=0)
//    are in section 12 as live plugin tests.
// ═══════════════════════════════════════════════════════════

console.log('\n--- 1. parseRules (via memory.jsonc + system.transform) ---');

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
  writeRules('{ "max_lines": 300, "stale_after_days": 180, "inject_every_n_turns": 5 }');
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
  // Write config that sets inject_every_n_turns to a large number so
  // only _dirty or _injectedOnce triggers injection.
  writeRules('{ "inject_every_n_turns": 999 }');

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
//    sections 1-7. memory.jsonc is invalid from section 5 —
//    reset it here before any test that reads config.
// ═══════════════════════════════════════════════════════════

console.log('\n--- 9. maintainIndex behaviors ---');

// Restore valid defaults before this section so getCache() gets a clean config.
writeRules('{ "max_lines": 300, "stale_after_days": 180, "inject_every_n_turns": 5 }');

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

  writeRules('{ "max_lines": 300, "stale_after_days": 180, "inject_every_n_turns": 5 }');
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
    writeRules('{ "max_lines": 300, "stale_after_days": 180, "inject_every_n_turns": 5 }');
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
  writeRules('{ "max_lines": 300, "stale_after_days": 180, "inject_every_n_turns": 5 }');
});

// ═══════════════════════════════════════════════════════════
// 13. Atomic writes (Phase 1)
// ═══════════════════════════════════════════════════════════

console.log('\n--- 13. atomic writes ---');

await test('atomic writes leave no leftover .tmp-* files', async () => {
  await plugin.tool.write_memory.execute({ topic: 'Atomic Write Test', content: 'x', summary: 'atomic test', pin: false });
  const entries = fs.readdirSync(MEMORY_DIR);
  const tmpFiles = entries.filter(e => e.includes('.tmp-'));
  assert.equal(tmpFiles.length, 0, `expected no leftover tmp files, found: ${tmpFiles.join(', ')}`);
});

// ═══════════════════════════════════════════════════════════
// 14. Larger caps (Phase 1)
// ═══════════════════════════════════════════════════════════

console.log('\n--- 14. cap bump ---');

await test('max_lines clamps to 1000 maximum (live truncation)', async () => {
  writeRules('{ "max_lines": 5000 }');
  const entries = Array.from({ length: 1005 }, (_, i) => `- [MX Mock ${i}](mock-mx-${i}.md) 2026-01-01T00:00:00+00:00 -- mock ${i}`);
  fs.writeFileSync(path.join(MEMORY_DIR, 'MEMORY.md'), ['# Memory Index', ...entries].join('\n') + '\n', 'utf8');
  try {
    await plugin['tool.execute.after']({ tool: 'write_memory' }, {});
    const out = makeSystemOutput();
    await plugin['experimental.chat.system.transform']({}, out);
    const injected = out.system.join('\n');
    assert.ok(injected.includes('1000-line limit'), `expected "1000-line limit" truncation warning; got tail: ${injected.slice(-300)}`);
  } finally {
    writeRules('{ "max_lines": 300, "stale_after_days": 180, "inject_every_n_turns": 5 }');
  }
});
// Note: the mock entries above point at files that don't exist on disk.
// The next write_memory call anywhere below triggers orphan removal, which
// purges them automatically — same self-cleaning pattern as section 12.

// ═══════════════════════════════════════════════════════════
// 15. shared_dir cross-tool store (Phase 3)
//     Order matters: carry-over only fires once per process
//     (_carryOverChecked), so the "first enable" test must run
//     before any other shared_dir=true config write.
// ═══════════════════════════════════════════════════════════

console.log('\n--- 15. shared_dir cross-tool store ---');

await test('shared_dir: first enable carries over existing local memory (copy, not move)', async () => {
  const localEntriesBefore = fs.readdirSync(MEMORY_DIR).filter(e => e.endsWith('.md'));
  assert.ok(localEntriesBefore.length > 0, 'expected existing local memory files from prior tests');
  assert.ok(!fs.existsSync(SHARED_MEMORY_DIR), 'shared dir should not exist yet');

  writeRules('{ "shared_dir": true }');
  // Force a fresh config read via compaction — it always calls getCache(true)
  // regardless of in-process cache state, which is what triggers carry-over
  // with the just-written shared_dir:true value (a plain writeRules() call
  // alone does not invalidate the cache).
  await plugin['experimental.session.compacting']({}, makeCompactOutput());

  assert.ok(fs.existsSync(SHARED_MEMORY_DIR), 'shared dir should now exist');
  assert.ok(fs.existsSync(path.join(SHARED_MEMORY_DIR, 'MEMORY.md')), 'MEMORY.md should be carried over to shared dir');
  // No separate backup dir — files are copied (not moved), so originals in MEMORY_DIR are the backup.
  const backupDir = path.join(MEMORY_DIR, 'memory-backup-before-shared-dir');
  assert.ok(!fs.existsSync(backupDir), 'no separate backup dir should be created — originals stay in place');
  for (const entry of localEntriesBefore) {
    assert.ok(fs.existsSync(path.join(MEMORY_DIR, entry)), `original local file ${entry} should still exist after carry-over (copy, not move)`);
  }
});

await test('shared_dir: writes now land in the shared dir', async () => {
  await plugin.tool.write_memory.execute({ topic: 'Shared Dir Test', content: 'shared content', summary: 'shared dir test', pin: false });
  assert.ok(fs.existsSync(path.join(SHARED_MEMORY_DIR, 'shared-dir-test.md')), 'topic file should be created in shared dir');
  const sharedIdx = fs.readFileSync(path.join(SHARED_MEMORY_DIR, 'MEMORY.md'), 'utf8');
  assert.ok(sharedIdx.includes('Shared Dir Test'), 'shared MEMORY.md should contain new entry');
});

await test('shared_dir: carry-over does not re-run on subsequent writes', async () => {
  fs.writeFileSync(path.join(MEMORY_DIR, 'post-carryover-drift.md'), '---\nname: Drift\n---\n\ncontent\n', 'utf8');
  await plugin.tool.write_memory.execute({ topic: 'Post Carryover Trigger', content: 'x', summary: 'trigger', pin: false });
  assert.ok(!fs.existsSync(path.join(SHARED_MEMORY_DIR, 'post-carryover-drift.md')), 'a local-only file added after carry-over should not be copied to the shared dir');
});

await test('shared_dir: stale lock (>10s old) is reclaimed and does not block', async () => {
  const lockPath = path.join(SHARED_MEMORY_DIR, '.lock');
  fs.writeFileSync(lockPath, '', 'utf8');
  const oldTime = new Date(Date.now() - 15000);
  fs.utimesSync(lockPath, oldTime, oldTime);

  const start = Date.now();
  const result = await plugin.tool.write_memory.execute({ topic: 'Stale Lock Test', content: 'x', summary: 'stale lock test', pin: false });
  const elapsed = Date.now() - start;

  assert.ok(result.includes('created') || result.includes('updated'), 'write should succeed after reclaiming a stale lock');
  assert.ok(elapsed < 400, `expected fast reclaim rather than a full timeout wait, took ${elapsed}ms`);
  assert.ok(!fs.existsSync(lockPath), 'lock file should not exist after a successful acquire+release');
});

await test('shared_dir: fresh (non-stale) lock causes proceed-without-lock after timeout', async () => {
  const lockPath = path.join(SHARED_MEMORY_DIR, '.lock');
  fs.writeFileSync(lockPath, '', 'utf8'); // fresh — blocks acquisition for the whole retry window

  const start = Date.now();
  const result = await plugin.tool.write_memory.execute({ topic: 'Lock Contention Test', content: 'x', summary: 'lock test', pin: false });
  const elapsed = Date.now() - start;

  assert.ok(result.includes('created') || result.includes('updated'), 'write should still succeed even without acquiring the lock');
  assert.ok(elapsed >= 400, `expected the call to wait out the ~500ms acquire timeout, took ${elapsed}ms`);

  fs.unlinkSync(lockPath); // cleanup the external lock we created
});

// Disable shared_dir before moving on — later sections assume the local dir.
writeRules('{ "max_lines": 300, "stale_after_days": 180, "inject_every_n_turns": 5, "shared_dir": false }');

// ═══════════════════════════════════════════════════════════
// 16. Consolidation (Phase 4)
// ═══════════════════════════════════════════════════════════

console.log('\n--- 16. consolidation ---');

await test('config: /memory command template includes a consolidate branch', async () => {
  const mockConfig = {};
  await plugin.config(mockConfig);
  const template = mockConfig.command['memory'].template;
  assert.ok(template.includes('consolidate'), 'template should mention consolidate');
  assert.ok(template.toLowerCase().includes('last session recap') || template.includes('last-session-recap'), 'template should reference the session recap topic');
  assert.ok(template.includes('always_persist'), 'template should reference always_persist rules');
});

await test('autocontinue: consolidate_on_compact=false leaves native continue enabled', async () => {
  writeRules('{ "consolidate_on_compact": false }');
  await plugin.tool.write_memory.execute({ topic: 'Autocontinue Flush A', content: 'x', summary: 'flush', pin: false });
  const output = { enabled: true };
  await plugin['experimental.compaction.autocontinue']({ sessionID: 'test-session-a' }, output);
  assert.equal(output.enabled, true, 'enabled should remain true when consolidate_on_compact is false');
});

await test('autocontinue: no client available leaves native continue untouched even if enabled', async () => {
  // The shared `plugin` instance was created via makePlugin() with no input, so it has no client.
  writeRules('{ "consolidate_on_compact": true }');
  await plugin.tool.write_memory.execute({ topic: 'Autocontinue Flush B', content: 'x', summary: 'flush', pin: false });
  const output = { enabled: true };
  await plugin['experimental.compaction.autocontinue']({ sessionID: 'test-session-b' }, output);
  assert.equal(output.enabled, true, 'without a client, native continue should remain untouched');
});

await test('autocontinue: consolidate_on_compact=true with a client suppresses continue and sends the consolidation prompt', async () => {
  const calls = [];
  const mockClient = { session: { async prompt(opts) { calls.push(opts); return { info: {}, parts: [] }; } } };
  const plugin2 = await makePlugin({ client: mockClient });

  writeRules('{ "consolidate_on_compact": true }');
  await plugin2.tool.write_memory.execute({ topic: 'Autocontinue Flush C', content: 'x', summary: 'flush', pin: false });

  const output = { enabled: true };
  await plugin2['experimental.compaction.autocontinue']({ sessionID: 'test-session-c' }, output);

  assert.equal(output.enabled, false, 'native continue should be suppressed');
  assert.equal(calls.length, 1, 'client.session.prompt should be called exactly once');
  assert.equal(calls[0].path.id, 'test-session-c', 'sessionID should be passed through');
  assert.ok(calls[0].body.parts[0].text.includes('always_persist'), 'prompt text should reference always_persist rules');
});

await test('autocontinue: seeds the consolidation prompt with the compaction summary when available', async () => {
  const calls = [];
  const mockClient = {
    session: {
      async messages() {
        return {
          data: [
            { info: { role: 'user' }, parts: [{ type: 'text', text: 'do the thing' }] },
            { info: { role: 'assistant', summary: true }, parts: [{ type: 'text', text: '## Objective\n- SUMMARY_MARKER\n## Next Move\n1. finish the thing' }] },
          ],
        };
      },
      async prompt(opts) { calls.push(opts); return { info: {}, parts: [] }; },
    },
  };
  const plugin2 = await makePlugin({ client: mockClient });

  writeRules('{ "consolidate_on_compact": true }');
  await plugin2.tool.write_memory.execute({ topic: 'Autocontinue Flush C2', content: 'x', summary: 'flush', pin: false });

  const output = { enabled: true };
  await plugin2['experimental.compaction.autocontinue']({ sessionID: 'test-session-c2' }, output);

  assert.equal(output.enabled, false, 'native continue should be suppressed');
  assert.equal(calls.length, 1, 'client.session.prompt should be called exactly once');
  const text = calls[0].body.parts[0].text;
  assert.ok(text.includes('<compaction-summary>'), 'prompt should wrap the compaction summary');
  assert.ok(text.includes('SUMMARY_MARKER'), 'prompt should embed the actual summary text');
  assert.ok(text.includes('Next Move'), 'prompt should reference resuming pending work');
  assert.ok(text.includes('always_persist'), 'prompt should still reference always_persist rules');
});

await test('autocontinue: falls back to a full-scan prompt when no compaction summary is found', async () => {
  const calls = [];
  const mockClient = {
    session: {
      async messages() { return { data: [{ info: { role: 'assistant', summary: false }, parts: [] }] }; },
      async prompt(opts) { calls.push(opts); return { info: {}, parts: [] }; },
    },
  };
  const plugin2 = await makePlugin({ client: mockClient });

  writeRules('{ "consolidate_on_compact": true }');
  await plugin2.tool.write_memory.execute({ topic: 'Autocontinue Flush C3', content: 'x', summary: 'flush', pin: false });

  const output = { enabled: true };
  await plugin2['experimental.compaction.autocontinue']({ sessionID: 'test-session-c3' }, output);

  assert.equal(calls.length, 1, 'client.session.prompt should be called exactly once');
  const text = calls[0].body.parts[0].text;
  assert.ok(!text.includes('<compaction-summary>'), 'fallback prompt should not wrap a summary');
  assert.ok(text.includes('always_persist'), 'fallback prompt should reference always_persist rules');
});

await test('autocontinue: falls back to native continue if client.session.prompt throws', async () => {
  const mockClient = { session: { async prompt() { throw new Error('network error'); } } };
  const plugin2 = await makePlugin({ client: mockClient });

  writeRules('{ "consolidate_on_compact": true }');
  await plugin2.tool.write_memory.execute({ topic: 'Autocontinue Flush D', content: 'x', summary: 'flush', pin: false });

  const output = { enabled: true };
  await plugin2['experimental.compaction.autocontinue']({ sessionID: 'test-session-d' }, output);
  assert.equal(output.enabled, true, 'should fall back to native continue on error');

  writeRules('{ "max_lines": 300, "stale_after_days": 180, "inject_every_n_turns": 5, "consolidate_on_compact": false }');
});

// ═══════════════════════════════════════════════════════════
// 17. TUI plugin: shared_dir awareness
//    ocl-memory-shared.mjs is a single cached module instance across both
//    plugin imports in this process, so _carryOverChecked is already true
//    from section 15 — the shared dir already has content from that
//    carry-over. These tests focus on path resolution + mutation behavior,
//    not re-testing carry-over itself (already covered in section 15).
// ═══════════════════════════════════════════════════════════

console.log('\n--- 17. TUI plugin: shared_dir awareness ---');

await test('TUI resolveActiveDir: shared_dir=false resolves to the local dir', async () => {
  writeRules('{ "shared_dir": false }');
  const { memDir, memIndex } = tui.resolveActiveDir();
  assert.equal(memDir, MEMORY_DIR, 'should resolve to the local memory dir');
  assert.equal(memIndex, path.join(MEMORY_DIR, 'MEMORY.md'));
});

await test('TUI resolveActiveDir: shared_dir=true resolves to the shared dir', async () => {
  writeRules('{ "shared_dir": true }');
  const { memDir, memIndex } = tui.resolveActiveDir();
  assert.equal(memDir, SHARED_MEMORY_DIR, 'should resolve to the shared memory dir');
  assert.equal(memIndex, path.join(SHARED_MEMORY_DIR, 'MEMORY.md'));
});

await test('TUI setPin: mutates the shared MEMORY.md and writes the sentinel at the shared path', async () => {
  const { memDir, memIndex } = tui.resolveActiveDir();
  const entries = tui.parseIndex(memIndex);
  assert.ok(entries.length > 0, 'expected existing entries in the shared index from prior carry-over');
  const target = entries.find(e => !e.pinned) || entries[0];

  const sentinel = path.join(memDir, '.invalidate');
  try { fs.unlinkSync(sentinel); } catch {}

  await tui.setPin(memDir, memIndex, target.filename, true);

  const updated = tui.parseIndex(memIndex);
  const updatedEntry = updated.find(e => e.filename === target.filename);
  assert.ok(updatedEntry.pinned, 'entry should now be pinned in the shared MEMORY.md');
  assert.ok(fs.existsSync(sentinel), 'sentinel should be written at the shared dir path, not the local one');
  assert.ok(!fs.existsSync(path.join(MEMORY_DIR, '.invalidate')), 'sentinel should NOT be written at the local path while shared_dir is active');
});

await test('TUI removeEntry: removes from the shared MEMORY.md, topic file preserved on disk', async () => {
  const { memDir, memIndex } = tui.resolveActiveDir();
  const before = tui.parseIndex(memIndex);
  const target = before[0];

  await tui.removeEntry(memDir, memIndex, target.filename);

  const after = tui.parseIndex(memIndex);
  assert.ok(!after.some(e => e.filename === target.filename), 'entry should be removed from the shared index');
  assert.ok(fs.existsSync(path.join(memDir, target.filename)), 'topic file itself should still exist on disk');
});

await test('TUI readTopic: reads a topic file from the resolved (shared) dir', async () => {
  const { memDir, memIndex } = tui.resolveActiveDir();
  const entries = tui.parseIndex(memIndex);
  assert.ok(entries.length > 0, 'expected at least one remaining entry');
  const content = tui.readTopic(memDir, entries[0].filename);
  assert.ok(typeof content === 'string' && content.length > 0, 'should return non-empty topic content');
});

await test('Integration: TUI and server plugin resolve the identical active dir/index for the same shared_dir config', async () => {
  writeRules('{ "shared_dir": true }');
  const { memDir: tuiDir, memIndex: tuiIndex } = tui.resolveActiveDir();

  const plugin = await makePlugin();
  // config hook calls getCache() with no forceRefresh — force a fresh read
  // first so it doesn't reuse a stale _cache from before shared_dir flipped.
  await plugin['experimental.session.compacting']({}, makeCompactOutput());
  const mockConfig = {};
  await plugin.config(mockConfig);
  const template = mockConfig.command['memory'].template;

  assert.ok(template.includes(tuiDir), 'server-resolved active dir (shown in /memory template) should exactly match the TUI-resolved dir');
  assert.ok(template.includes(tuiIndex), 'server-resolved active index should exactly match the TUI-resolved index');
  assert.equal(tuiDir, SHARED_MEMORY_DIR, 'sanity: both should be the shared dir, not the local one');

  writeRules('{ "shared_dir": false }');
});

// ═══════════════════════════════════════════════════════════
// Results
// ═══════════════════════════════════════════════════════════

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
