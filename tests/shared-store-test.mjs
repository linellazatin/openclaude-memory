// Run with an optional pi core path to exercise the actual cross-harness writer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.argv[2] === '--worker') {
  const [name, piPath] = process.argv.slice(3);
  const core = piPath ? await import(pathToFileURL(piPath)) : null;
  const plugin = core ? null : await (await import('../.opencode/plugins/ocl-memory.mjs')).default();
  process.send('ready');
  await new Promise(resolve => process.once('message', resolve));
  if (core) await core.retireRecapEntries();
  for (let i = 0; i < 10; i++) {
    const args = { topic: `Writer ${name} ${i}`, content: `body-${name}-${i}`, summary: `writer ${name}`, pin: i === 1, mode: 'append' };
    const result = core ? await core.executeWriteMemory(args) : await plugin.tool.write_memory.execute(args);
    assert.doesNotMatch(result, /busy|error|invalid/i);
  }
  const args = { topic: `Writer ${name} 0` };
  const result = core ? await core.executeRemoveMemory(args) : await plugin.tool.remove_memory.execute(args);
  assert.match(result, /removed/i);
  process.disconnect();
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocl-memory-concurrent-'));
  const piPath = process.argv[2] && path.resolve(process.argv[2]);
  const sharedDir = path.join(tmp, '.agents', 'memory');
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.mkdirSync(path.join(tmp, 'config', 'opencode'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'pi'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'config', 'opencode', 'memory.jsonc'), '{ "shared_dir": true }');
  fs.writeFileSync(path.join(tmp, 'pi', 'memory.jsonc'), '{ "shared_dir": true }');
  fs.writeFileSync(path.join(sharedDir, 'seed.md'), 'seed');
  fs.writeFileSync(path.join(sharedDir, 'last-session-recap.md'), 'retired recap');
  fs.writeFileSync(path.join(sharedDir, 'MEMORY.md'), '# Memory Index\n\n- [Seed](seed.md) -- seed\n- [Recap](last-session-recap.md) -- retired\n');
  const children = [];
  const completions = [];
  try {
    const ready = ['A', 'B'].map(name => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', name, ...(name === 'B' && piPath ? [piPath] : [])], {
        env: { ...process.env, XDG_CONFIG_HOME: path.join(tmp, 'config'), OCL_SHARED_MEMORY_HOME: tmp, PI_SHARED_MEMORY_HOME: tmp, PI_CODING_AGENT_DIR: path.join(tmp, 'pi') },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      children.push(child);
      let errors = '';
      child.stderr.on('data', data => { errors += data; });
      completions.push(new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(`writer ${name}: ${errors}`)));
      }));
      return new Promise((resolve, reject) => {
        child.once('message', resolve);
        child.once('error', reject);
        child.once('exit', code => { if (code !== 0) reject(new Error(errors)); });
      });
    });
    const timer = setTimeout(() => { for (const child of children) child.kill(); }, 30000);
    try {
      await Promise.all(ready);
      for (const child of children) child.send('go');
      await Promise.all(completions);
    } finally { clearTimeout(timer); }
    const index = fs.readFileSync(path.join(sharedDir, 'MEMORY.md'), 'utf8');
    assert.ok(index.includes('(seed.md)'), 'startup maintenance must preserve a co-tenant entry');
    const entries = index.split('\n').filter(line => line.startsWith('- [Writer '));
    assert.equal(entries.length, 18, 'both writers retain every non-removed entry');
    const removed = fs.readFileSync(path.join(sharedDir, '.ocl-removed'), 'utf8');
    for (const name of ['A', 'B']) {
      assert.ok(removed.includes(`writer-${name.toLowerCase()}-0.md`));
      for (let i = 1; i < 10; i++) {
        const file = `writer-${name.toLowerCase()}-${i}.md`;
        const line = entries.find(entry => entry.includes(`(${file})`));
        assert.ok(line, file);
        assert.ok(fs.readFileSync(path.join(sharedDir, file), 'utf8').includes(`body-${name}-${i}`));
        if (i === 1) assert.ok(line.includes('[pin]'));
      }
    }
    assert.ok(!fs.existsSync(path.join(sharedDir, '.lock')));
    assert.ok(!fs.readdirSync(sharedDir).some(file => file.includes('.tmp-')));
    console.log(`PASS concurrent ${piPath ? 'OpenCode/pi' : 'OpenCode/OpenCode'} writers: topics, pins, removals and foreign entries preserved`);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.allSettled(completions);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
