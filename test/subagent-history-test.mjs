import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-test-'));
process.env.QQ_AGENT_DATA_DIR = dir;
try {
  const { ChatStore } = await import('../src/store.js');
  const store = new ChatStore();
  store.appendIncoming('group:1', { mid: 2, ts: 2000, text: 'live' });
  const history = [{ mid: 1, ts: 1000, text: 'old', self: false }, { mid: 2, ts: 2000, text: 'duplicate' }];
  assert.equal(store.importHistory('group:1', history), 1);
  assert.equal(store.importHistory('group:1', history), 0);
  assert.equal(store.unreadCount('group:1'), 1);
  assert.deepEqual(store.recent('group:1', { limit: 10 }).map((m) => m.mid), [1, 2]);
  assert.equal(store.findByMid('group:1', 1).read, true);
  assert.equal(new ChatStore().findByMid('group:1', 1).historical, true);

  const { updateConfig } = await import('../src/config.js');
  updateConfig({ subagent: { enabled: true, provider: 'worker', model: 'worker-model' },
    providers: [{ id: 'worker', baseURL: 'https://worker.example/v1', models: ['worker-model'] }],
    dshProviderKeys: { worker: 'test-key' } });
  const { buildToolDefs, executeTool, getImagePartsOrVideo } = await import('../src/tools.js');
  let body;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    assert.equal(options.headers.authorization, 'Bearer test-key');
    return new Response(JSON.stringify({ choices: [{ message: { content: 'x'.repeat(2000) }, finish_reason: 'stop' }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await executeTool(buildToolDefs(), { chatKey: 'group:1', store }, 'delegate_analysis',
      { task: 'summarize', source: 'z'.repeat(30000) });
    assert.equal(result.isError, undefined, result.content);
    const payload = JSON.parse(result.content);
    assert.equal(payload.summary.length, 1800);
    assert.equal(payload.inputTruncated, true);
    assert.equal(body.messages.length, 2);
    assert.equal(body.model, 'worker-model');
    assert.equal(body.tools, undefined);
    assert.ok(body.messages[1].content.length < 21000);
    assert.equal(body.max_tokens, 1024);
    updateConfig({ subagent: { mode: 'memes', visionProvider: 'vision', visionModel: 'vision-model' },
      providers: [{ id: 'worker', baseURL: 'https://worker.example/v1', models: ['worker-model'] },
        { id: 'vision', baseURL: 'https://vision.example/v1', models: ['vision-model'] }],
      dshProviderKeys: { worker: 'test-key', vision: 'vision-key' } });
    const calls = [];
    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body);
      calls.push(request);
      return new Response(JSON.stringify({ choices: [{ message: { content: request.model === 'vision-model' ? '画面事实' : '含义解释' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const imageResult = await getImagePartsOrVideo('image', [{ dataUrl: 'data:image/png;base64,aGVsbG8=' }], { store, chatKey: 'group:1' });
    assert.deepEqual(calls.map((r) => r.model), ['vision-model', 'worker-model']);
    assert.ok(calls[0].messages[1].content.some((p) => p.type === 'image_url'));
    assert.ok(!JSON.stringify(calls[1]).includes('base64'));
    assert.ok(imageResult.content.every((p) => p.type === 'text'));
    assert.ok(imageResult.content[0].text.includes('含义解释'));
    assert.ok(!buildToolDefs().some((t) => t.id === 'delegate_analysis'));
  } finally { globalThis.fetch = originalFetch; }
  console.log('PASS: history dedup/read/order/persistence; isolated bounded subagent');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
