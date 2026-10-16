// Real OpenCode V2 server + a local fake model. No API key, external model or real memory store.
// Drives `opencode run --standalone` (which handles auth internally) against a plugin directory,
// and asserts V2 tool registration/execution plus per-request memory injection.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocl-memory-host-v2-'));
const requests = [];
let stored = false;

const modelServer = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let body = {};
  try { body = JSON.parse(raw); } catch {}
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
    res.end(JSON.stringify({ id: 'audit', object: 'chat.completion', created: 1, model: 'test', choices: [{ index: 0, message: { role: 'assistant', ...delta }, finish_reason: write ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
    return;
  }
  res.setHeader('content-type', 'text/event-stream');
  const chunk = (data, finish = null) => `data: ${JSON.stringify({ id: 'audit', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta: data, finish_reason: finish }] })}\n\n`;
  res.end(chunk({ role: 'assistant', ...delta }) + chunk({}, write ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
});
await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
const providerURL = `http://127.0.0.1:${modelServer.address().port}/v1`;

// V2 configured plugin paths must be directories whose entrypoint is index.mjs.
const pluginDir = path.join(tmp, 'plugin');
fs.mkdirSync(pluginDir, { recursive: true });
fs.writeFileSync(path.join(pluginDir, 'index.mjs'), `export { default } from ${JSON.stringify(new URL('../.opencode/plugins/ocl-memory.mjs', import.meta.url).href)};\n`);

const configDir = path.join(tmp, 'config', 'opencode');
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(path.join(configDir, 'memory.jsonc'), '{ "always_persist": ["HOST_RULE_MARKER"], "consolidate_on_compact": true }');
const config = {
  plugins: [pluginDir],
  model: 'audit/test',
  permissions: [{ action: 'shell', resource: '*', effect: 'allow' }],
  provider: { audit: { npm: '@ai-sdk/openai-compatible', name: 'Local audit', options: { baseURL: providerURL, apiKey: 'local-test-only' }, models: { test: { name: 'Test', limit: { context: 128000, output: 4096 } } } } },
};

let logs = '';
const child = spawn(process.env.OPENCODE_BIN || 'opencode', ['run', '--standalone', 'PROBE_STORE', '--print-logs'], {
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
child.stdout.on('data', data => { logs += data; });
child.stderr.on('data', data => { logs += data; });
const exit = await new Promise(resolve => child.once('exit', resolve));

try {
  assert.equal(exit, 0, `opencode run exited ${exit}\n${logs.slice(-4000)}`);
  assert.ok(stored, 'the host must register and execute write_memory');
  const index = fs.readFileSync(path.join(configDir, 'memory', 'MEMORY.md'), 'utf8');
  assert.ok(index.includes('HOST_MEMORY_MARKER'), 'MEMORY.md must contain the stored marker');
  const systemText = request => (request.messages || []).filter(m => m.role === 'system').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
  const toolCallReq = requests.find(r => (r.tools || []).some(t => t.function?.name === 'write_memory'));
  const toolCallIdx = requests.indexOf(toolCallReq);
  const later = requests.slice(toolCallIdx + 1).find(r => (r.messages || []).some(m => m.role === 'tool'));
  assert.ok(later, 'a later request (tool-result round-trip) must occur after the store');
  assert.ok(systemText(later).includes('HOST_MEMORY_MARKER'), 'the stored marker must reach a later request system context');
  assert.ok(systemText(later).includes('HOST_RULE_MARKER'), 'the always-persist rule must reach a later request system context');
  const errLines = logs.split('\n').filter(l => /error|Error|invalid|Invalid|undefined is not|Cannot read/i.test(l) && !/role=server|message=event|Sent HTTP|spawning|provider\.updated|watcher/i.test(l));
  assert.deepEqual(errLines, [], `unexpected error lines:\n${errLines.slice(0, 10).join('\n')}`);
  console.log('PASS real OpenCode V2 host: tool registration, execution and per-request memory injection');
} finally {
  child.kill();
  await new Promise(resolve => modelServer.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}