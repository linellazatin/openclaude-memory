// Real OpenCode server + a local fake model. No API key, external model or real memory store.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocl-memory-host-'));
const requests = [];
let stored = false;
const modelServer = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  const lastUser = body.messages.filter(m => m.role === 'user').at(-1);
  const text = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content);
  const write = !stored && text?.includes('PROBE_STORE') && body.tools?.some(t => t.function?.name === 'write_memory');
  if (write) stored = true;
  const delta = write
    ? { tool_calls: [{ index: 0, id: 'call-memory-audit', type: 'function', function: { name: 'write_memory', arguments: JSON.stringify({ topic: 'Harness Audit Entry', content: 'Host model stored this memory.', summary: 'HOST_MEMORY_MARKER', pin: false, mode: 'append' }) } }] }
    : { content: '## Objective\nHost integration check complete.\n## Next Move\nNo pending work.' };
  if (!body.stream) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'audit', object: 'chat.completion', created: 1, model: 'test', choices: [{ index: 0, message: { role: 'assistant', ...delta }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
    return;
  }
  res.setHeader('content-type', 'text/event-stream');
  const chunk = (data, finish = null) => `data: ${JSON.stringify({ id: 'audit', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta: data, finish_reason: finish }] })}\n\n`;
  res.end(chunk({ role: 'assistant', ...delta }) + chunk({}, write ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
});
await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
const providerURL = `http://127.0.0.1:${modelServer.address().port}/v1`;
const configDir = path.join(tmp, 'config', 'opencode');
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(path.join(configDir, 'memory.jsonc'), '{ "always_persist": ["HOST_RULE_MARKER"], "consolidate_on_compact": true }');
const config = {
  plugin: [new URL('../.opencode/plugins/ocl-memory.mjs', import.meta.url).href],
  model: 'audit/test', small_model: 'audit/test', permission: 'allow', snapshot: false,
  provider: { audit: { npm: '@ai-sdk/openai-compatible', name: 'Local audit', options: { baseURL: providerURL, apiKey: 'local-test-only' }, models: { test: { name: 'Test', limit: { context: 128000, output: 4096 } } } } },
};
let logs = '';
const child = spawn(process.env.OPENCODE_BIN || 'opencode', ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
  cwd: tmp,
  env: {
    ...process.env,
    XDG_CONFIG_HOME: path.join(tmp, 'config'), XDG_DATA_HOME: path.join(tmp, 'data'), XDG_CACHE_HOME: path.join(tmp, 'cache'), XDG_STATE_HOME: path.join(tmp, 'state'),
    OCL_SHARED_MEMORY_HOME: tmp, OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
    OPENCODE_SERVER_PASSWORD: '', OPENCODE_SERVER_USERNAME: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', data => { logs += data; });
const exit = new Promise(resolve => child.once('exit', resolve));
try {
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`OpenCode startup timed out: ${logs}`)), 60000);
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`OpenCode exited ${code}: ${logs}`)); });
    child.stdout.on('data', data => {
      logs += data;
      const match = logs.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  const api = async (route, body) => {
    const response = await fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    const text = await response.text();
    assert.ok(response.ok, `${route}: ${response.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
  const session = await api('/session', {});
  const first = await api(`/session/${session.id}/message`, { parts: [{ type: 'text', text: 'PROBE_STORE' }] });
  assert.ok(!first.info?.error, JSON.stringify(first));
  assert.ok(stored, 'the host must register and execute write_memory');
  const index = fs.readFileSync(path.join(configDir, 'memory', 'MEMORY.md'), 'utf8');
  assert.ok(index.includes('HOST_MEMORY_MARKER'));
  await api(`/session/${session.id}/message`, { parts: [{ type: 'text', text: 'PROBE_NEXT' }] });
  const next = requests.find(r => r.messages.some(m => JSON.stringify(m.content).includes('PROBE_NEXT')));
  assert.ok(next);
  const systemText = request => request.messages.filter(m => m.role === 'system').map(m => JSON.stringify(m.content)).join('\n');
  assert.ok(systemText(next).includes('HOST_MEMORY_MARKER'));
  assert.ok(systemText(next).includes('HOST_RULE_MARKER'));
  const another = await api('/session', {});
  await api(`/session/${another.id}/message`, { parts: [{ type: 'text', text: 'PROBE_OTHER_SESSION' }] });
  const other = requests.find(r => r.messages.some(m => JSON.stringify(m.content).includes('PROBE_OTHER_SESSION')));
  assert.ok(systemText(other).includes('HOST_MEMORY_MARKER'));
  await api(`/session/${session.id}/summarize`, { providerID: 'audit', modelID: 'test', auto: true });
  assert.ok(requests.some(r => r.messages.some(m => JSON.stringify(m.content).includes('<compaction-summary>'))), 'automatic compaction must enqueue and run consolidation without deadlocking');
  console.log('PASS real OpenCode host: tool registration, per-request memory, session isolation and automatic consolidation');
} finally {
  child.kill();
  await exit;
  await new Promise(resolve => modelServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}
