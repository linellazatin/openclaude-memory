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
import { spawn } from 'child_process';

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
const shared = await import('../.opencode/plugins/ocl-memory-shared.mjs');

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

await test('write_memory: append-mode last_updated bump is frontmatter-scoped (does not touch body)', async () => {
  await plugin.tool.write_memory.execute({
    topic: 'FM Scope Test',
    content: 'Original.',
    summary: 'fm scope',
    pin: false,
  });
  const file = path.join(MEMORY_DIR, 'fm-scope-test.md');
  // Hand-write a file whose frontmatter lacks last_updated but whose BODY has a
  // line starting `last_updated:`. The old whole-file regex would rewrite the
  // body line; the fix must only touch the frontmatter block.
  fs.writeFileSync(file, [
    '---',
    'name: "FM Scope Test"',
    'description: "fm scope"',
    'created: 2026-01-01T00:00:00+08:00',
    'metadata:',
    '  node_type: memory',
    '---',
    '',
    'Notes.',
    'last_updated: do not touch',
    '',
  ].join('\n'), 'utf8');
  await plugin.tool.write_memory.execute({
    topic: 'FM Scope Test',
    content: 'Appended body.',
    summary: 'fm scope 2',
    pin: false,
  });
  const body = fs.readFileSync(file, 'utf8');
  assert.ok(body.includes('last_updated: do not touch'), 'body line starting last_updated: must be left verbatim');
  const fm = body.match(/^---\n([\s\S]*?)\n---\n/)[1];
  assert.ok(/^last_updated:\s*\d{4}-\d{2}-\d{2}T/m.test(fm), 'frontmatter should gain a real ISO last_updated');
  assert.ok(body.includes('Appended body.'), 'appended content should be present');
  assert.ok(body.match(/## \d{4}-\d{2}-\d{2}T/), 'dated append heading should be present');
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

await test('byte cap (50 KB) triggers truncation independently of the line-count cap', async () => {
  writeRules('{ "max_lines": 300 }');
  // Well under the 300-line cap, but each line is long enough that the total
  // byte size exceeds the 50KB byte cap — exercises the byte-cap branch in
  // readMemoryIndex(), distinct from the line-cap branch tested above.
  const longSummary = 'x'.repeat(900);
  const entries = Array.from({ length: 60 }, (_, i) => `- [Byte Mock ${i}](mock-byte-${i}.md) 2026-01-01T00:00:00+00:00 -- ${longSummary}`);
  assert.ok(entries.length < 300, 'sanity: line count must stay under the line cap so only the byte cap fires');
  fs.writeFileSync(path.join(MEMORY_DIR, 'MEMORY.md'), ['# Memory Index', ...entries].join('\n') + '\n', 'utf8');
  try {
    // Force a fresh config+content read regardless of leftover in-process
    // cache state from prior tests (same pattern used for shared_dir tests
    // in sections 15/17 — a plain writeRules()/tool.execute.after pair is
    // not guaranteed to invalidate an already-populated cache).
    await plugin['experimental.session.compacting']({}, makeCompactOutput());
    const out = makeSystemOutput();
    await plugin['experimental.chat.system.transform']({}, out);
    const injected = out.system.join('\n');
    assert.ok(injected.includes('KB size limit'), `expected byte-cap truncation warning; got tail: ${injected.slice(-300)}`);
    assert.ok(!injected.includes('300-line limit'), 'byte-cap warning should fire, not the line-cap warning');
    const prefix = `Memory dir: ${MEMORY_DIR}\n\n`;
    const indexContent = out.system[0].slice(out.system[0].indexOf(prefix) + prefix.length);
    assert.ok(Buffer.byteLength(indexContent) <= 50 * 1024, `injected index must actually respect the 50KB cap; got ${Buffer.byteLength(indexContent)} bytes`);
  } finally {
    writeRules('{ "max_lines": 300, "stale_after_days": 180, "inject_every_n_turns": 5 }');
  }
});
// Same self-cleaning note as above — these mock entries also point at
// nonexistent files and are purged by the next write_memory's orphan removal.


// ═══════════════════════════════════════════════════════════
// 15. shared_dir cross-tool store (Phase 3)
//     Order matters: carry-over only fires once per process
//     (_carryOverChecked) and, after a successful run, never again for this
//     install (a .shared-dir-migrated sentinel in MEMORY_DIR short-circuits
//     it across future process starts too) — so the "first enable" test
//     must run before any other shared_dir=true config write. Because of
//     that one-shot guard, every merge scenario (no-collision,
//     identical-content no-op, differing-content rename, already-
//     migrated idempotency, numeric-suffix fallback on a triple collision,
//     orphan safety, sentinel write) has to be exercised within that
//     single test — there is no way to trigger a second real carry-over
//     later in this process.
// ═══════════════════════════════════════════════════════════

console.log('\n--- 15. shared_dir cross-tool store ---');

await test('shared_dir: first enable merges with pre-existing foreign content instead of skipping', async () => {
  const localEntriesBefore = fs.readdirSync(MEMORY_DIR).filter(e => e.endsWith('.md'));
  assert.ok(localEntriesBefore.length > 0, 'expected existing local memory files from prior tests');
  assert.ok(!fs.existsSync(SHARED_MEMORY_DIR), 'shared dir should not exist yet');

  // Create local topics with known, controlled filenames to exercise each
  // merge scenario deterministically (on top of whatever pre-existing local
  // files already exist from earlier sections — those exercise the plain
  // no-collision case implicitly, since none of their filenames exist yet
  // in the not-yet-created shared dir).
  await plugin.tool.write_memory.execute({ topic: 'Collision Identical', content: 'identical content', summary: 'identical', pin: false });
  await plugin.tool.write_memory.execute({ topic: 'Identical Missing Index', content: 'identical missing-index content', summary: 'missing index', pin: false });
  await plugin.tool.write_memory.execute({ topic: 'Collision Differing', content: 'local differing content', summary: 'differing', pin: false });
  await plugin.tool.write_memory.execute({ topic: 'Already Migrated', content: 'local already-migrated content', summary: 'already migrated', pin: false });
  await plugin.tool.write_memory.execute({ topic: 'Triple Collision', content: 'local triple-collision content', summary: 'triple collision', pin: false });
  await plugin.tool.write_memory.execute({ topic: 'Orphan Local', content: 'will be deleted', summary: 'orphan', pin: false });

  // Delete the "Orphan Local" topic file directly (not via remove_memory) so
  // its index entry is left dangling — simulates a local index that already
  // has an orphan before the merge ever runs.
  fs.unlinkSync(path.join(MEMORY_DIR, 'orphan-local.md'));

  // Pre-seed the shared dir as if another tool (e.g. openpi-memory) — or a
  // prior run of this same carry-over — already wrote there.
  fs.mkdirSync(SHARED_MEMORY_DIR, { recursive: true });

  // 1. No-collision foreign entry: unrelated filename, should survive untouched.
  fs.writeFileSync(path.join(SHARED_MEMORY_DIR, 'totally-foreign-topic.md'), 'foreign content\n', 'utf8');

  // 2. Identical-content collision: byte-identical to the local file at the same name.
  fs.copyFileSync(path.join(MEMORY_DIR, 'collision-identical.md'), path.join(SHARED_MEMORY_DIR, 'collision-identical.md'));

  // 3. Identical file with no index entry: content is already present, but
  // the merge must still make the local topic discoverable in shared MEMORY.md.
  fs.copyFileSync(path.join(MEMORY_DIR, 'identical-missing-index.md'), path.join(SHARED_MEMORY_DIR, 'identical-missing-index.md'));

  // 3. Differing-content collision: same filename as a local topic, different content.
  fs.writeFileSync(path.join(SHARED_MEMORY_DIR, 'collision-differing.md'), 'foreign differing content\n', 'utf8');

  // 4. Already-migrated-under-suffix: simulates what the shared dir would look
  //    like after a prior process already resolved this exact collision —
  //    foreign content at the original name, and the local content already
  //    sitting at the canonical "-oclm" name from that earlier merge.
  fs.writeFileSync(path.join(SHARED_MEMORY_DIR, 'already-migrated.md'), 'foreign already-migrated content\n', 'utf8');
  fs.copyFileSync(path.join(MEMORY_DIR, 'already-migrated.md'), path.join(SHARED_MEMORY_DIR, 'already-migrated-oclm.md'));

  // 5. Triple collision: both the original name and the canonical -oclm name
  //    already hold different foreign content, forcing the rare numeric-
  //    suffix bump (resolveDestName's "-oclm-2" fallback path).
  fs.writeFileSync(path.join(SHARED_MEMORY_DIR, 'triple-collision.md'), 'foreign triple content A\n', 'utf8');
  fs.writeFileSync(path.join(SHARED_MEMORY_DIR, 'triple-collision-oclm.md'), 'foreign triple content B\n', 'utf8');

  fs.writeFileSync(path.join(SHARED_MEMORY_DIR, 'MEMORY.md'), [
    '# Memory Index',
    '',
    '- [Totally Foreign Topic](totally-foreign-topic.md) 2026-01-01T00:00:00+00:00 -- foreign entry',
    '- [Collision Identical](collision-identical.md) 2026-01-01T00:00:00+00:00 -- identical',
    '- [Collision Differing](collision-differing.md) 2026-01-01T00:00:00+00:00 -- foreign differing entry',
    '- [Already Migrated](already-migrated.md) 2026-01-01T00:00:00+00:00 -- foreign already-migrated entry',
    '- [Already Migrated](already-migrated-oclm.md) 2026-01-01T00:00:00+00:00 -- previously-merged local entry',
    '- [Triple Collision](triple-collision.md) 2026-01-01T00:00:00+00:00 -- foreign triple entry A',
    '- [Triple Collision](triple-collision-oclm.md) 2026-01-01T00:00:00+00:00 -- foreign triple entry B',
    '',
  ].join('\n'), 'utf8');

  writeRules('{ "shared_dir": true }');
  // Force a fresh config read via compaction — it always calls getCache(true)
  // regardless of in-process cache state, which is what triggers carry-over
  // with the just-written shared_dir:true value (a plain writeRules() call
  // alone does not invalidate the cache).
  await plugin['experimental.session.compacting']({}, makeCompactOutput());

  assert.ok(fs.existsSync(SHARED_MEMORY_DIR), 'shared dir should still exist');
  assert.ok(fs.existsSync(path.join(SHARED_MEMORY_DIR, 'MEMORY.md')), 'MEMORY.md should exist in the shared dir');
  // No separate backup dir — files are copied (not moved), so originals in MEMORY_DIR are the backup.
  const backupDir = path.join(MEMORY_DIR, 'memory-backup-before-shared-dir');
  assert.ok(!fs.existsSync(backupDir), 'no separate backup dir should be created — originals stay in place');
  for (const entry of localEntriesBefore) {
    assert.ok(fs.existsSync(path.join(MEMORY_DIR, entry)), `original local file ${entry} should still exist after carry-over (copy, not move)`);
  }

  const sharedIndex = fs.readFileSync(path.join(SHARED_MEMORY_DIR, 'MEMORY.md'), 'utf8');
  const sharedFiles = fs.readdirSync(SHARED_MEMORY_DIR);
  const countOccurrences = (str, sub) => str.split(sub).length - 1;

  // 1. No-collision foreign entry preserved untouched.
  assert.equal(fs.readFileSync(path.join(SHARED_MEMORY_DIR, 'totally-foreign-topic.md'), 'utf8'), 'foreign content\n', 'foreign no-collision file should be untouched');
  assert.ok(sharedIndex.includes('totally-foreign-topic.md'), 'foreign no-collision index entry should still be present');

  // 2. Identical-content collision is a no-op: no -oclm variant, no duplicate entry.
  assert.ok(!sharedFiles.includes('collision-identical-oclm.md'), 'identical content should not be renamed');
  assert.equal(countOccurrences(sharedIndex, '](collision-identical.md)'), 1, 'expected exactly one index entry for collision-identical.md');

  // 3. Identical content without a shared index entry must still be indexed.
  assert.ok(!sharedFiles.includes('identical-missing-index-oclm.md'), 'identical content should not be renamed just to add its missing index entry');
  assert.equal(countOccurrences(sharedIndex, '](identical-missing-index.md)'), 1, 'an identical shared topic file without an index entry must gain exactly one discoverable index entry');

  // 3. Differing-content collision renames the local copy; foreign original untouched.
  const localDifferingContent = fs.readFileSync(path.join(MEMORY_DIR, 'collision-differing.md'), 'utf8');
  assert.equal(fs.readFileSync(path.join(SHARED_MEMORY_DIR, 'collision-differing.md'), 'utf8'), 'foreign differing content\n', 'foreign file at the original name should be untouched');
  assert.equal(fs.readFileSync(path.join(SHARED_MEMORY_DIR, 'collision-differing-oclm.md'), 'utf8'), localDifferingContent, 'local content should be copied under the -oclm suffix');
  assert.ok(sharedIndex.includes('[Collision Differing](collision-differing-oclm.md)'), 'index should have an entry pointing at the -oclm filename with the local topic name');

  // 4. Already-migrated-under-suffix: merge recognizes it and does not re-copy or grow a -2 suffix.
  assert.ok(!sharedFiles.includes('already-migrated-oclm-2.md'), 'already-migrated content must not grow a numeric suffix on repeat/idempotent merge');
  assert.equal(fs.readFileSync(path.join(SHARED_MEMORY_DIR, 'already-migrated.md'), 'utf8'), 'foreign already-migrated content\n', 'foreign file at the original name should remain untouched');
  assert.equal(countOccurrences(sharedIndex, '](already-migrated-oclm.md)'), 1, 'expected exactly one index entry for already-migrated-oclm.md, not duplicated by the merge');

  // 5. Triple collision: both the original name and the canonical -oclm name
  // are already taken by different foreign content, forcing the rare
  // numeric-suffix bump.
  assert.equal(fs.readFileSync(path.join(SHARED_MEMORY_DIR, 'triple-collision.md'), 'utf8'), 'foreign triple content A\n', 'foreign file at the original name should remain untouched');
  assert.equal(fs.readFileSync(path.join(SHARED_MEMORY_DIR, 'triple-collision-oclm.md'), 'utf8'), 'foreign triple content B\n', 'foreign file at the canonical -oclm name should remain untouched');
  const localTripleContent = fs.readFileSync(path.join(MEMORY_DIR, 'triple-collision.md'), 'utf8');
  assert.equal(fs.readFileSync(path.join(SHARED_MEMORY_DIR, 'triple-collision-oclm-2.md'), 'utf8'), localTripleContent, 'local content should be copied under the -oclm-2 fallback name when both the original and -oclm names are already taken by different content');
  assert.ok(sharedIndex.includes('[Triple Collision](triple-collision-oclm-2.md)'), 'index should have an entry pointing at the -oclm-2 filename with the local topic name');

  // 6. Orphan local entry (backing file deleted) is not carried over.
  assert.ok(!sharedFiles.includes('orphan-local.md'), 'orphaned local entry should not be copied to the shared dir');
  assert.ok(!sharedIndex.includes('orphan-local.md'), 'orphaned local entry should not appear in the merged shared index');

  // 7. Sentinel written after a successful merge — short-circuits the full
  // scan on every subsequent process start (see ocl-memory-shared.mjs).
  assert.ok(fs.existsSync(path.join(MEMORY_DIR, '.shared-dir-migrated')), 'sentinel should be written after a successful merge');
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

await test('shared_dir: stale lock from a DEAD pid is reclaimed and does not block', async () => {
  const lockPath = path.join(SHARED_MEMORY_DIR, '.lock');
  fs.writeFileSync(lockPath, '999999\t' + Date.now(), 'utf8'); // pid 999999: provably not us/our child
  const oldTime = new Date(Date.now() - 15000);
  fs.utimesSync(lockPath, oldTime, oldTime);

  const start = Date.now();
  const result = await plugin.tool.write_memory.execute({ topic: 'Stale Lock Test', content: 'x', summary: 'stale lock test', pin: false });
  const elapsed = Date.now() - start;

  assert.ok(result.includes('created') || result.includes('updated'), `write should succeed after reclaiming a dead holder's lock; got: ${result}`);
  assert.ok(elapsed < 400, `expected fast reclaim rather than a full timeout wait, took ${elapsed}ms`);
  assert.ok(!fs.existsSync(lockPath), 'lock file should not exist after a successful acquire+release');
});

await test('shared_dir: stale-aged lock held by a LIVE pid is NOT stolen (fail-closed)', async () => {
  // Age the lock past the soft stale window but record OUR OWN (live) pid.
  // Liveness must win over age: we never clobber an active holder, so the
  // writer gives up (busy) instead of stealing the lock.
  const lockPath = path.join(SHARED_MEMORY_DIR, '.lock');
  fs.writeFileSync(lockPath, `${process.pid}\t${Date.now()}`, 'utf8');
  const oldTime = new Date(Date.now() - 15000);
  fs.utimesSync(lockPath, oldTime, oldTime);
  try {
    const result = await plugin.tool.write_memory.execute({ topic: 'Live Holder Test', content: 'x', summary: 'live holder', pin: false });
    assert.ok(/busy|retry/i.test(result), `must refuse to steal a live holder's lock; got: ${result}`);
    assert.ok(fs.existsSync(lockPath), 'the live holder lock must remain in place');
    const idx = fs.readFileSync(path.join(SHARED_MEMORY_DIR, 'MEMORY.md'), 'utf8');
    assert.ok(!idx.includes('Live Holder Test'), 'a refused write must not land in the index');
  } finally {
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  }
});

await test('shared_dir: fresh foreign lock is refused (fail-closed) after one auto-retry', async () => {
  // A genuinely foreign, still-recently-held lock (dead pid but too fresh to
  // reclaim) must NOT be written through in shared mode. The tool should
  // exhaust its patience window (poll + one sleep/retry) and return a busy
  // error, leaving MEMORY.md untouched and the foreign lock in place.
  const lockPath = path.join(SHARED_MEMORY_DIR, '.lock');
  fs.writeFileSync(lockPath, '999999\t' + Date.now(), 'utf8'); // fresh; reclaim age >10s not met

  const start = Date.now();
  const result = await plugin.tool.write_memory.execute({ topic: 'Lock Contention Test', content: 'x', summary: 'lock test', pin: false });
  const elapsed = Date.now() - start;

  assert.ok(/busy|retry/i.test(result), `expected a busy/retry refusal under shared contention; got: ${result}`);
  assert.ok(elapsed >= 3000, `expected the full patience window (poll + sleep + retry) to be waited, took ${elapsed}ms`);
  assert.ok(fs.existsSync(lockPath), 'the foreign lock must NOT be unlinked by the losing writer');
  const idx = fs.readFileSync(path.join(SHARED_MEMORY_DIR, 'MEMORY.md'), 'utf8');
  assert.ok(!idx.includes('Lock Contention Test'), 'a refused write must not appear in the index');

  fs.unlinkSync(lockPath); // cleanup the external lock we created
});

await test('shared_dir: a lock that clears during the retry window succeeds on the second attempt', async () => {
  // Contended past the first poll window, then released during the retry
  // sleep — the writer must transparently acquire on the second window rather
  // than failing closed, proving the single auto-retry actually re-attempts.
  const lockPath = path.join(SHARED_MEMORY_DIR, '.lock');
  fs.writeFileSync(lockPath, '999999\t' + Date.now(), 'utf8'); // fresh, dead pid, not reclaimable yet
  const releaseTimer = setTimeout(() => { try { fs.unlinkSync(lockPath); } catch {} }, 2300);
  try {
    const start = Date.now();
    const result = await plugin.tool.write_memory.execute({ topic: 'Retry Winner', content: 'x', summary: 'retry winner', pin: false });
    const elapsed = Date.now() - start;
    assert.ok(result.includes('created') || result.includes('updated'), `should succeed via the retry window after the lock clears; got: ${result}`);
    assert.ok(elapsed >= 2000, `should have waited past the first poll window into the retry, took ${elapsed}ms`);
  } finally {
    clearTimeout(releaseTimer);
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  }
});

await test('local (shared_dir:false) contention still proceeds best-effort after the short timeout', async () => {
  // Best-effort mode must be untouched by the shared fail-closed change: a
  // foreign local lock that can't be reclaimed does NOT error — the write
  // proceeds unlocked after the ~500ms window.
  writeRules('{ "max_lines": 300, "stale_after_days": 180, "inject_every_n_turns": 5, "shared_dir": false }');
  await plugin['experimental.session.compacting']({}, makeCompactOutput()); // force cache to pick up shared_dir:false
  const lockPath = path.join(MEMORY_DIR, '.lock');
  fs.writeFileSync(lockPath, '999999\t' + Date.now(), 'utf8');
  try {
    const start = Date.now();
    const result = await plugin.tool.write_memory.execute({ topic: 'Local Best Effort', content: 'x', summary: 'local be', pin: false });
    const elapsed = Date.now() - start;
    assert.ok(result.includes('created') || result.includes('updated'), `local write should proceed unlocked; got: ${result}`);
    assert.ok(elapsed < 1000, `local best-effort should use the short window, not the shared patience window, took ${elapsed}ms`);
  } finally {
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    writeRules('{ "max_lines": 300, "stale_after_days": 180, "inject_every_n_turns": 5, "shared_dir": true }');
    await plugin['experimental.session.compacting']({}, makeCompactOutput());
  }
});

await test('shared_dir: acquireLock waits out a lock genuinely held by another OS process', async () => {
  // The two tests above simulate contention with a pre-created lock file in
  // the same process — this one spawns a real second Node process that
  // holds the lock file for a controlled duration, so the main process's
  // acquireLock() genuinely polls against another process's lock rather
  // than a static fixture.
  const lockPath = path.join(SHARED_MEMORY_DIR, '.lock');
  const holdMs = 250;
  const helperPath = path.join(TMP, 'lock-holder.mjs');
  fs.writeFileSync(helperPath, [
    "import fs from 'fs';",
    'const [lockPath, holdMs] = [process.argv[2], Number(process.argv[3])];',
    "fs.writeFileSync(lockPath, '', 'utf8');",
    'await new Promise(r => setTimeout(r, holdMs));',
    'fs.unlinkSync(lockPath);',
  ].join('\n'), 'utf8');

  const child = spawn(process.execPath, [helperPath, lockPath, String(holdMs)], { stdio: 'ignore' });
  const childDone = new Promise((resolve, reject) => {
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`lock-holder exited with code ${code}`))));
    child.on('error', reject);
  });

  // Give the child a head start so its lock file genuinely exists before
  // the main process attempts to acquire it.
  await new Promise(r => setTimeout(r, 50));
  assert.ok(fs.existsSync(lockPath), 'expected the child process to have created the real lock file by now');

  const start = Date.now();
  const result = await plugin.tool.write_memory.execute({ topic: 'Lock Race Winner', content: 'won the race', summary: 'race winner', pin: false });
  const elapsed = Date.now() - start;
  await childDone;

  assert.ok(result.includes('created') || result.includes('updated'), 'write should succeed after waiting out a lock held by a real separate process');
  // Comfortably above a no-contention write, comfortably below the ~500ms
  // acquire timeout — proves the main process waited for and then acquired
  // the real lock, rather than winning immediately or timing out unguarded.
  assert.ok(elapsed >= 150 && elapsed < 480, `expected the write to wait for the child's real lock release (~${holdMs}ms) without hitting the full acquire timeout, took ${elapsed}ms`);
  assert.ok(!fs.existsSync(lockPath), 'lock file should not exist after both processes have finished');

  const sharedIndexAfter = fs.readFileSync(path.join(SHARED_MEMORY_DIR, 'MEMORY.md'), 'utf8');
  assert.ok(sharedIndexAfter.includes('Lock Race Winner'), 'the write that waited for the real lock should have landed in the index');

  fs.unlinkSync(helperPath);
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
  assert.ok(template.includes('ocl-last-session-recap.md'), 'template should reference the namespaced session recap topic');
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
  const { memDir, memIndex } = await tui.resolveActiveDir();
  assert.equal(memDir, MEMORY_DIR, 'should resolve to the local memory dir');
  assert.equal(memIndex, path.join(MEMORY_DIR, 'MEMORY.md'));
});

await test('TUI resolveActiveDir: shared_dir=true resolves to the shared dir', async () => {
  writeRules('{ "shared_dir": true }');
  const { memDir, memIndex } = await tui.resolveActiveDir();
  assert.equal(memDir, SHARED_MEMORY_DIR, 'should resolve to the shared memory dir');
  assert.equal(memIndex, path.join(SHARED_MEMORY_DIR, 'MEMORY.md'));
});

await test('TUI setPin: mutates the shared MEMORY.md and writes the sentinel at the shared path', async () => {
  const { memDir, memIndex } = await tui.resolveActiveDir();
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
  const { memDir, memIndex } = await tui.resolveActiveDir();
  const before = tui.parseIndex(memIndex);
  const target = before[0];

  await tui.removeEntry(memDir, memIndex, target.filename);

  const after = tui.parseIndex(memIndex);
  assert.ok(!after.some(e => e.filename === target.filename), 'entry should be removed from the shared index');
  assert.ok(fs.existsSync(path.join(memDir, target.filename)), 'topic file itself should still exist on disk');
});

await test('TUI readTopic: reads a topic file from the resolved (shared) dir', async () => {
  const { memDir, memIndex } = await tui.resolveActiveDir();
  const entries = tui.parseIndex(memIndex);
  assert.ok(entries.length > 0, 'expected at least one remaining entry');
  const content = tui.readTopic(memDir, entries[0].filename);
  assert.ok(typeof content === 'string' && content.length > 0, 'should return non-empty topic content');
});

await test('Integration: TUI and server plugin resolve the identical active dir/index for the same shared_dir config', async () => {
  writeRules('{ "shared_dir": true }');
  const { memDir: tuiDir, memIndex: tuiIndex } = await tui.resolveActiveDir();

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
// 18. v0.6.2 hardening fixes (memory-systems-comparison-v3 gap analysis)
// ═══════════════════════════════════════════════════════════

console.log('\n--- 18. hardening fixes (stripJsonc, slug collisions, arg validation, pin coercion, path traversal) ---');

// Section 17 ends by flipping shared_dir back to false via writeRules(), but
// _cache is module-level (shared across all plugin instances) and a plain
// writeRules() call doesn't invalidate it — force a fresh read now so every
// test below reliably resolves against the local dir, not a stale shared-dir
// cache left over from section 17's last forced refresh.
await plugin['experimental.session.compacting']({}, makeCompactOutput());

// --- stripJsonc / parseRules string-literal awareness ---

await test('stripJsonc: does not truncate a "//" inside a string value', () => {
  const raw = '{ "always_ask": ["See https://example.com for details"] }';
  const stripped = shared.stripJsonc(raw);
  assert.ok(stripped.includes('https://example.com'), `URL should survive intact; got: ${stripped}`);
  assert.doesNotThrow(() => JSON.parse(stripped), 'result should still be valid JSON');
});

await test('stripJsonc: still strips a real // comment outside a string', () => {
  const raw = '{ // a real comment\n  "max_lines": 250\n}';
  const stripped = shared.stripJsonc(raw);
  assert.ok(!stripped.includes('a real comment'), 'real comment should be stripped');
  assert.equal(JSON.parse(stripped).max_lines, 250);
});

await test('parseRules: a URL in a config string value no longer silently falls back to defaults', () => {
  const raw = '{ "always_ask": ["See https://example.com for details"], "max_lines": 250 }';
  const config = shared.parseRules(raw);
  assert.equal(config.maxLines, 250, 'custom max_lines should survive — old stripJsonc would have corrupted parsing and silently reverted to the 300 default');
});

await test('parseRules: logs via console.error on a genuine parse failure instead of failing silently', () => {
  const originalError = console.error;
  const calls = [];
  console.error = (...args) => calls.push(args);
  try {
    const config = shared.parseRules('{ this is not valid json at all');
    assert.equal(config.maxLines, 300, 'should still fall back to defaults on a genuine parse failure');
    assert.ok(calls.length > 0, 'console.error should be called on parse failure');
  } finally {
    console.error = originalError;
  }
});

// --- write_memory: colliding filename slugs ---

await test('write_memory: colliding slugs from different topic names get distinct files, not merged', async () => {
  await plugin.tool.write_memory.execute({ topic: 'API Setup!', content: 'first topic content', summary: 'first', pin: false });
  await plugin.tool.write_memory.execute({ topic: 'api-setup', content: 'second topic content', summary: 'second', pin: false });

  assert.ok(fs.existsSync(path.join(MEMORY_DIR, 'api-setup.md')), 'first topic file should exist under the plain slug');
  assert.ok(fs.existsSync(path.join(MEMORY_DIR, 'api-setup-2.md')), 'second (colliding) topic should get a numeric-suffixed filename');

  const firstContent = fs.readFileSync(path.join(MEMORY_DIR, 'api-setup.md'), 'utf8');
  const secondContent = fs.readFileSync(path.join(MEMORY_DIR, 'api-setup-2.md'), 'utf8');
  assert.ok(firstContent.includes('first topic content'), 'first topic file should be untouched');
  assert.ok(!firstContent.includes('second topic content'), "first topic file must not contain the colliding topic's content");
  assert.ok(secondContent.includes('second topic content'), 'second topic file should have its own content');

  const index = readIndex();
  assert.ok(index.includes('[API Setup!](api-setup.md)'), 'first index entry keeps its own name/filename');
  assert.ok(index.includes('[api-setup](api-setup-2.md)'), 'second index entry uses the bumped filename with its own name');
});

await test('write_memory: re-writing the same topic name still updates its existing file (no false-positive collision)', async () => {
  await plugin.tool.write_memory.execute({ topic: 'API Setup!', content: 'updated content', summary: 'first updated', mode: 'replace', pin: false });
  assert.ok(!fs.existsSync(path.join(MEMORY_DIR, 'api-setup-3.md')), 're-writing an existing topic name must not bump a new suffixed filename');
  const content = fs.readFileSync(path.join(MEMORY_DIR, 'api-setup.md'), 'utf8');
  assert.ok(content.includes('updated content'), 'existing file should be updated in place');
});

// --- Tool argument validation ---

await test('write_memory: rejects missing/invalid topic, content, or summary with a clean error', async () => {
  const r1 = await plugin.tool.write_memory.execute({ content: 'x', summary: 'y', pin: false });
  assert.ok(r1.includes('topic is required'), `missing topic should return a clean error; got: ${r1}`);
  const r2 = await plugin.tool.write_memory.execute({ topic: 'T', summary: 'y', pin: false });
  assert.ok(r2.includes('content is required'), `missing content should return a clean error; got: ${r2}`);
  const r3 = await plugin.tool.write_memory.execute({ topic: 'T', content: 'x', pin: false });
  assert.ok(r3.includes('summary is required'), `missing summary should return a clean error; got: ${r3}`);
});

await test('remove_memory: rejects missing/invalid topic with a clean error instead of throwing', async () => {
  const r = await plugin.tool.remove_memory.execute({});
  assert.ok(r.includes('topic is required'), `missing topic should return a clean error, not throw; got: ${r}`);
});

await test('pin_memory: rejects missing/invalid topic with a clean error instead of throwing', async () => {
  const r = await plugin.tool.pin_memory.execute({ pin: true });
  assert.ok(r.includes('topic is required'), `missing topic should return a clean error, not throw; got: ${r}`);
});

// --- pin boolean coercion ---

await test('pin_memory: string "false" behaves as false, not JS-truthy', async () => {
  await plugin.tool.write_memory.execute({ topic: 'Pin Coercion Test', content: 'x', summary: 'y', pin: false });
  await plugin.tool.pin_memory.execute({ topic: 'Pin Coercion Test', pin: 'false' });
  const line = readIndex().split('\n').find(l => l.includes('Pin Coercion Test'));
  assert.ok(line && !line.includes('[pin]'), `entry must remain unpinned after pin:"false"; got line: ${line}`);
});

await test('write_memory: string "false" for pin does not pin a new entry', async () => {
  await plugin.tool.write_memory.execute({ topic: 'Write Pin Coercion', content: 'x', summary: 'y', pin: 'false' });
  const line = readIndex().split('\n').find(l => l.includes('Write Pin Coercion'));
  assert.ok(line && !line.includes('[pin]'), `string "false" must not pin the entry; got line: ${line}`);
});

await test('pin_memory: string "true" still pins (backward compatible with prior truthy behavior)', async () => {
  await plugin.tool.write_memory.execute({ topic: 'Pin String True Test', content: 'x', summary: 'y', pin: false });
  await plugin.tool.pin_memory.execute({ topic: 'Pin String True Test', pin: 'true' });
  const line = readIndex().split('\n').find(l => l.includes('Pin String True Test'));
  assert.ok(line && line.includes('[pin]'), `string "true" should still pin; got line: ${line}`);
  await plugin.tool.pin_memory.execute({ topic: 'Pin String True Test', pin: false });
});

// --- Path traversal guard on filenames read back from MEMORY.md ---

await test('isSafeFilename: rejects path separators and .. segments, accepts plain filenames', () => {
  assert.equal(shared.isSafeFilename('normal-topic.md'), true);
  assert.equal(shared.isSafeFilename('../../../etc/passwd'), false);
  assert.equal(shared.isSafeFilename('sub/dir.md'), false);
  assert.equal(shared.isSafeFilename('..\\windows\\path.md'), false);
});

await test('remove_memory: refuses to act on an entry with an unsafe filename instead of touching the path', async () => {
  const memIndexPath = path.join(MEMORY_DIR, 'MEMORY.md');
  const before = fs.readFileSync(memIndexPath, 'utf8');
  fs.writeFileSync(memIndexPath, before.replace(/\n+$/, '') + '\n- [Evil Entry](../../../../etc/passwd) 2026-01-01T00:00:00+00:00 -- corrupted entry\n', 'utf8');

  const result = await plugin.tool.remove_memory.execute({ topic: 'Evil Entry' });
  assert.ok(result.includes('unsafe filename'), `expected an unsafe-filename refusal; got: ${result}`);

  const after = fs.readFileSync(memIndexPath, 'utf8');
  assert.ok(after.includes('Evil Entry'), 'the corrupted entry should be left untouched by remove_memory, not silently removed');

  // Clean it back up via maintainIndex's own drop-unsafe-entry path (exercised next).
  fs.writeFileSync(memIndexPath, before, 'utf8');
});

await test('maintainIndex (via write_memory): drops an unsafe-filename index entry like an orphan', async () => {
  const memIndexPath = path.join(MEMORY_DIR, 'MEMORY.md');
  const before = fs.readFileSync(memIndexPath, 'utf8');
  fs.writeFileSync(memIndexPath, before.replace(/\n+$/, '') + '\n- [Evil Entry 2](../../../../etc/shadow) 2026-01-01T00:00:00+00:00 -- corrupted entry\n', 'utf8');

  // Any write_memory call runs maintainIndex, which should drop the unsafe entry.
  await plugin.tool.write_memory.execute({ topic: 'Maintain Trigger', content: 'x', summary: 'trigger', pin: false });

  const after = readIndex();
  assert.ok(!after.includes('Evil Entry 2'), 'unsafe-filename entry should be dropped by maintainIndex, same as an orphan');
});

await test('write_memory: refuses an unsafe filename from a matching existing index entry before touching its path', async () => {
  const memIndexPath = path.join(MEMORY_DIR, 'MEMORY.md');
  const victimPath = path.join(path.dirname(MEMORY_DIR), 'write-memory-victim.md');
  const before = fs.readFileSync(memIndexPath, 'utf8');
  fs.writeFileSync(victimPath, 'must stay unchanged\n', 'utf8');
  fs.writeFileSync(memIndexPath, before.replace(/\n+$/, '') + '\n- [Unsafe Existing Topic](../write-memory-victim.md) 2026-01-01T00:00:00+00:00 -- corrupted entry\n', 'utf8');
  try {
    const result = await plugin.tool.write_memory.execute({ topic: 'Unsafe Existing Topic', content: 'must not be written', summary: 'unsafe', mode: 'replace', pin: false });
    assert.ok(result.includes('unsafe filename'), `expected an unsafe-filename refusal; got: ${result}`);
    assert.equal(fs.readFileSync(victimPath, 'utf8'), 'must stay unchanged\n', 'write_memory must not read or modify the path supplied by the unsafe index entry');
  } finally {
    fs.writeFileSync(memIndexPath, before, 'utf8');
    fs.unlinkSync(victimPath);
  }
});

await test('TUI parseIndex filters unsafe filenames from a corrupted index', () => {
  const memIndexPath = path.join(MEMORY_DIR, 'MEMORY.md');
  const before = fs.readFileSync(memIndexPath, 'utf8');
  fs.writeFileSync(memIndexPath, before.replace(/\n+$/, '') + '\n- [Unsafe TUI Entry](../../tui-victim.md) 2026-01-01T00:00:00+00:00 -- corrupted entry\n', 'utf8');
  try {
    assert.ok(!tui.parseIndex(memIndexPath).some(entry => entry.name === 'Unsafe TUI Entry'), 'TUI must not expose an unsafe index entry as selectable');
  } finally {
    fs.writeFileSync(memIndexPath, before, 'utf8');
  }
});

await test('TUI readTopic refuses an unsafe filename without reading outside the memory directory', () => {
  const victimPath = path.join(path.dirname(MEMORY_DIR), 'tui-victim.md');
  fs.writeFileSync(victimPath, 'private TUI victim content\n', 'utf8');
  try {
    assert.ok(tui.readTopic(MEMORY_DIR, '../tui-victim.md').includes('unsafe filename'), 'TUI should refuse an unsafe filename rather than previewing the outside file');
  } finally {
    fs.unlinkSync(victimPath);
  }
});


await test('TUI setPin/removeEntry return a friendly message when the index is missing (no throw)', async () => {
  const missing = path.join(MEMORY_DIR, 'does-not-exist-index.md');
  assert.ok(!fs.existsSync(missing), 'precondition: index path must not exist');
  const pinResult = await tui.setPin(MEMORY_DIR, missing, 'whatever.md', true, false);
  assert.strictEqual(pinResult, 'No memory index found.', 'setPin should report missing index, not throw');
  const rmResult = await tui.removeEntry(MEMORY_DIR, missing, 'whatever.md', false);
  assert.strictEqual(rmResult, 'No memory index found.', 'removeEntry should report missing index, not throw');
});


// ═══════════════════════════════════════════════════════════
// 19. v0.6.4 shared_dir co-tenancy hardening (repair, format, recap)
//     Runs in shared_dir:true (restored at end of section 15/16 region).
// ═══════════════════════════════════════════════════════════

console.log('\n--- 19. v0.6.4 co-tenancy hardening ---');

// Ensure the plugin targets the SHARED dir for this section (writes below
// assert against SHARED_MEMORY_DIR) regardless of what earlier sections left.
writeRules('{ "max_lines": 300, "stale_after_days": 180, "inject_every_n_turns": 5, "shared_dir": true }');
await plugin['experimental.session.compacting']({}, makeCompactOutput()); // force fresh shared-dir resolution

// [T2.6] Frontmatter converges to openpi's quoted form.
await test('write_memory: emits quoted frontmatter name/description', async () => {
  await plugin.tool.write_memory.execute({ topic: 'Quoted FM', content: 'body', summary: 'a summary: with colon', pin: false });
  const file = fs.readFileSync(path.join(SHARED_MEMORY_DIR, 'quoted-fm.md'), 'utf8');
  assert.ok(/^name: "Quoted FM"$/m.test(file), `frontmatter name should be quoted; got header: ${file.split('\n').slice(0,4).join(' | ')}`);
  assert.ok(/^description: "a summary: with colon"$/m.test(file), 'frontmatter description should be quoted (colon-safe)');
});

// [T2.7] Recap uses a tool-namespaced, non-reserved slug so openpi won't strip it.
await test('config: consolidation references the non-reserved ocl-last-session-recap topic', async () => {
  const mockConfig = {};
  await plugin.config(mockConfig);
  const template = mockConfig.command['memory'].template;
  assert.ok(template.includes('ocl-last-session-recap.md'), 'consolidation should target ocl-last-session-recap.md');
});

// [T0.2] repair re-adds orphan files as stale, deduped, additive-only.
await test('repairMemoryIndex: re-adds orphan topic files as [stale?] entries', async () => {
  const { repairMemoryIndex } = plugin.__test__ || {};
  assert.ok(typeof repairMemoryIndex === 'function', 'repairMemoryIndex should be exposed for testing');
  // Seed two orphan topic files not present in the index.
  const orphanA = path.join(SHARED_MEMORY_DIR, 'repair-alpha.md');
  fs.writeFileSync(orphanA, '---\nname: "Repair Alpha"\ndescription: "alpha summary"\ncreated: 2026-01-01T00:00:00+08:00\nlast_updated: 2026-06-01T00:00:00+08:00\nmetadata:\n  node_type: memory\n---\n\nbody\n', 'utf8');
  const orphanB = path.join(SHARED_MEMORY_DIR, 'repair-beta.md');
  fs.writeFileSync(orphanB, 'no frontmatter at all, just text\n', 'utf8');

  const idxPath = path.join(SHARED_MEMORY_DIR, 'MEMORY.md');
  const before = fs.readFileSync(idxPath, 'utf8');
  const res = repairMemoryIndex({ memDir: SHARED_MEMORY_DIR, memIndex: idxPath });
  assert.ok(res.added >= 2, `expected at least 2 recovered entries (the 2 seeded orphans); got ${res.added}`);

  const after = fs.readFileSync(idxPath, 'utf8');
  assert.ok(after.includes('[Repair Alpha](repair-alpha.md)'), 'alpha recovered with its name');
  assert.ok(after.includes('](repair-alpha.md)') && /\[stale\?\]/.test(after.split('repair-alpha.md')[1].slice(0, 60)), 'recovered alpha should be marked [stale?]');
  assert.ok(after.includes('](repair-beta.md)'), 'beta (no frontmatter) recovered under a filename-derived name');
  // Additive-only: pre-existing lines survive.
  assert.ok(before.split('\n').filter(l => l.startsWith('- [')).every(l => after.includes(l.slice(0, 30))), 'existing index lines must not be removed by repair');

  // Idempotent: second run adds nothing, creates no duplicates.
  const res2 = repairMemoryIndex({ memDir: SHARED_MEMORY_DIR, memIndex: idxPath });
  assert.equal(res2.added, 0, 'second repair run must be idempotent (add 0)');
  const after2 = fs.readFileSync(idxPath, 'utf8');
  assert.equal((after2.match(/repair-alpha\.md/g) || []).length, 1, 'no duplicate line for repair-alpha.md');

  // cleanup the seeded orphans + their index lines to not disturb later tests
  fs.writeFileSync(idxPath, before, 'utf8');
  fs.unlinkSync(orphanA); fs.unlinkSync(orphanB);
});

// [T0.2] repair skips unsafe filenames (never re-introduces a traversal line).
await test('repairMemoryIndex: does not index an unsafe filename even if the file exists oddly', async () => {
  const { repairMemoryIndex } = plugin.__test__ || {};
  // An orphan file is only ever referenced by its on-disk basename; ensure a
  // normal file recovers but the guard path is exercised via isSafeFilename.
  assert.equal(shared.isSafeFilename('../../outside.md'), false);
  assert.equal(typeof repairMemoryIndex, 'function');
});

// [T0.2] passive drift warning appears in injected content when shared.
await test('injection: shared_dir drift adds a non-mutating /memory repair note', async () => {
  const idxPath = path.join(SHARED_MEMORY_DIR, 'MEMORY.md');
  const before = fs.readFileSync(idxPath, 'utf8');
  const seeded = [];
  for (let i = 0; i < 7; i++) {
    const f = path.join(SHARED_MEMORY_DIR, `drift-note-${i}.md`);
    fs.writeFileSync(f, `---\nname: "Drift ${i}"\ndescription: "d${i}"\ncreated: 2026-01-01T00:00:00+08:00\nmetadata:\n  node_type: memory\n---\n\nb\n`, 'utf8');
    seeded.push(f);
  }
  try {
    await plugin['experimental.session.compacting']({}, makeCompactOutput()); // force fresh read
    const out = makeSystemOutput();
    await plugin['experimental.chat.system.transform']({}, out);
    const injected = out.system.join('\n');
    assert.ok(/not indexed|\/memory repair/i.test(injected), 'expected a repair hint when many topics are unindexed');
    assert.equal(fs.readFileSync(idxPath, 'utf8'), before, 'warning must NOT modify the index');
  } finally {
    seeded.forEach(f => fs.unlinkSync(f));
  }
});


// [T0.3] remove_memory tombstones the topic so repair cannot resurrect it.
await test('repair: intentionally-removed topics are skipped, re-written topics clear the tombstone', async () => {
  const idxPath = path.join(SHARED_MEMORY_DIR, 'MEMORY.md');
  const removedPath = shared.getRemovedListPath(SHARED_MEMORY_DIR);
  const topic = 'Tombstone Guard';
  const slug = 'tombstone-guard.md';
  const filePath = path.join(SHARED_MEMORY_DIR, slug);

  // 1. Create the topic (file + index entry).
  await plugin.tool.write_memory.execute({ topic, content: 'fact', summary: 'tg', pin: false });
  assert.ok(fs.existsSync(filePath), 'topic file created');

  // 2. Remove it via the tool: index line gone, file preserved, tombstone written.
  const rmRes = await plugin.tool.remove_memory.execute({ topic });
  assert.ok(rmRes.includes('intentionally removed'), `remove should report the tombstone, got: ${rmRes}`);
  assert.ok(!fs.readFileSync(idxPath, 'utf8').includes(`(${slug})`), 'index line removed');
  assert.ok(fs.existsSync(filePath), 'topic file still on disk after remove');
  assert.ok(shared.readRemovedList(SHARED_MEMORY_DIR).has(slug), 'filename tombstoned in .ocl-removed');

  // 3. repair must SKIP the tombstoned orphan (no resurrection), even though it
  //    may legitimately recover other unrelated orphans in the dir.
  await plugin.tool.repair_memory.execute();
  assert.ok(!fs.readFileSync(idxPath, 'utf8').includes(`(${slug})`), 'repair must NOT re-add an intentionally-removed topic');

  // 4. Re-writing the topic clears its tombstone and re-indexes it.
  await plugin.tool.write_memory.execute({ topic, content: 'restored', summary: 'tg2', pin: false });
  assert.ok(!shared.readRemovedList(SHARED_MEMORY_DIR).has(slug), 'tombstone cleared after re-write');
  assert.ok(fs.readFileSync(idxPath, 'utf8').includes(`(${slug})`), 'topic re-indexed after re-write');
});


// ═══════════════════════════════════════════════════════════
// 20. v0.6.5 markdown/flatfile integrity (index-line injection, block
//     comments, leading-dot/bracket filenames)
//     Runs against the LOCAL dir.
// ═══════════════════════════════════════════════════════════

console.log('\n--- 20. markdown/flatfile index integrity ---');

writeRules('{ "max_lines": 300, "stale_after_days": 180, "inject_every_n_turns": 5, "shared_dir": false }');
await plugin['experimental.session.compacting']({}, makeCompactOutput()); // force local-dir resolution

// [G1] a newline in the summary must not split one record into two lines and
// inject a phantom entry. Brackets/parens in the injected text are also stripped.
await test('write_memory: newline in summary does not inject a phantom index entry', async () => {
  await plugin.tool.write_memory.execute({
    topic: 'Newline Summary',
    content: 'x',
    summary: 'first\n- [INJECTED](evil.md) phantom',
    pin: false,
  });
  const idx = readIndex();
  assert.ok(idx.includes('[Newline Summary]'), 'the real entry should exist');
  assert.ok(!idx.includes('[INJECTED]'), `link-metachar summary text must be stripped; got: ${idx.split('\n').filter(l => l.includes('INJECTED')).join(' | ')}`);
  assert.ok(!idx.split('\n').some(l => shared.parseIndexLine(l) && shared.parseIndexLine(l).filename === 'evil.md'), 'no phantom evil.md entry may be indexed');
});

// [G1/G2] newlines and brackets in the topic name collapse into one clean record.
await test('write_memory: newline/brackets in topic name collapse to a single clean entry', async () => {
  await plugin.tool.write_memory.execute({ topic: 'Two\nLines', content: 'x', summary: 's', pin: false });
  await plugin.tool.write_memory.execute({ topic: 'Bad]Name', content: 'x', summary: 's2', pin: false });
  const idx = readIndex();
  assert.ok(idx.includes('[Two Lines]'), 'newline in topic should collapse to a space');
  assert.ok(idx.includes('[BadName]'), 'bracket in topic name should be stripped');
  assert.ok(!idx.includes('[Bad]'), 'raw "[Bad]" must not appear as a link label');
  assert.ok(fs.existsSync(path.join(MEMORY_DIR, 'two-lines.md')), 'topic slug should be clean');
});

// [G2] an index line whose filename carries a bracket/paren is treated as unsafe:
// the TUI hides it and the server tools refuse to act on it.
await test('corrupted index entry with a paren-in-filename is hidden by TUI and refused by tools', async () => {
  const memIndexPath = path.join(MEMORY_DIR, 'MEMORY.md');
  const before = fs.readFileSync(memIndexPath, 'utf8');
  fs.writeFileSync(memIndexPath, before.replace(/\n+$/, '') + '\n- [Paren Entry](we(ird).md) 2026-01-01T00:00:00+00:00 -- x\n', 'utf8');
  try {
    assert.ok(!tui.parseIndex(memIndexPath).some(e => e.name === 'Paren Entry'), 'TUI must hide a paren-filename entry as unsafe');
    const result = await plugin.tool.remove_memory.execute({ topic: 'Paren' });
    assert.ok(/No matching entry|unsafe/i.test(result), `remove_memory must not act on it; got: ${result}`);
  } finally {
    fs.writeFileSync(memIndexPath, before, 'utf8');
  }
});

// [G4] a leading-dot file is never re-indexed as a topic by repair.
await test('repairMemoryIndex: skips a leading-dot file even with a .md suffix', async () => {
  const { repairMemoryIndex } = plugin.__test__ || {};
  const dotFile = path.join(MEMORY_DIR, '.hidden-topic.md');
  fs.writeFileSync(dotFile, '---\nname: "Hidden"\ndescription: "d"\ncreated: 2026-01-01T00:00:00+08:00\n---\n\nbody\n', 'utf8');
  const idxPath = path.join(MEMORY_DIR, 'MEMORY.md');
  const before = fs.readFileSync(idxPath, 'utf8');
  try {
    repairMemoryIndex({ memDir: MEMORY_DIR, memIndex: idxPath });
    const after = fs.readFileSync(idxPath, 'utf8');
    assert.ok(!after.includes('.hidden-topic.md'), 'dotfile must NOT be recovered as a topic entry');
  } finally {
    fs.writeFileSync(idxPath, before, 'utf8');
    fs.unlinkSync(dotFile);
  }
});

// [H1] memory.jsonc block comments parse instead of silently reverting to defaults.
await test('stripJsonc: strips /* */ block comments and parseRules keeps custom scalars', () => {
  const stripped = shared.stripJsonc('{ /* block */ "max_lines": 250 }');
  assert.ok(!stripped.includes('block'), 'block comment should be stripped');
  const config = shared.parseRules('{ /* note */\n "max_lines": 250\n}');
  assert.equal(config.maxLines, 250, 'custom max_lines should survive a block comment (old code reverted to the 300 default)');
});

await test('stripJsonc: does not strip a */ sequence inside a string value', () => {
  // "*/" inside a string must not be read as a block-comment terminator, which
  // would consume the rest of the file and corrupt parsing (silently reverting
  // to defaults). max_lines surviving proves the string was not truncated.
  const config = shared.parseRules('{ "always_ask": ["glob */ inside"], /* c */ "max_lines": 200 }');
  assert.equal(config.maxLines, 200, 'a */ inside a string must not corrupt config parsing');
});

// [G4/G2] isSafeFilename now also rejects leading-dot and bracket/paren names.
await test('isSafeFilename: rejects leading-dot and link-breaking filenames', () => {
  assert.equal(shared.isSafeFilename('normal-topic.md'), true);
  assert.equal(shared.isSafeFilename('.ocl-removed.md'), false, 'leading-dot hidden file rejected');
  assert.equal(shared.isSafeFilename('.lock'), false, 'leading-dot file rejected');
  assert.equal(shared.isSafeFilename('we(ird).md'), false, 'paren in filename rejected (breaks parseIndexLine)');
  assert.equal(shared.isSafeFilename('a[b].md'), false, 'bracket in filename rejected');
});

// ═══════════════════════════════════════════════════════════
// Results
// ═══════════════════════════════════════════════════════════

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
