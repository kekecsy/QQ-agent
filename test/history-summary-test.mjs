import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-test-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const original = globalThis.fetch;
try {
  const { updateConfig } = await import('../src/config.js');
  updateConfig({ api: { model: 'summary-model', baseUrl: 'https://summary.example/v1', apiKey: 'test' }, store: { historySummary: { enabled: true } } });
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.equal(body.tools, undefined);
    assert.equal(body.messages.length, 2);
    return new Response(JSON.stringify({ choices: [{ message: { content: '大家在讨论午饭，甲在等问题回复。' } }] }));
  };
  const { compactHistory } = await import('../src/history-summary.js');
  const messages = Array.from({ length: 80 }, (_, i) => ({ id: i, ts: 1000 + i, senderId: 'a', senderName: '甲', text: `message ${i}` }));
  const first = await compactHistory('group:1', messages);
  assert.equal(first.messages.length, 20);
  assert.equal(first.count, 60);
  await compactHistory('group:1', messages);
  assert.equal(calls, 1);
  const next = await compactHistory('group:1', [...messages, { id: 80, ts: 1080, text: 'new' }]);
  assert.equal(calls, 1);
  assert.equal(next.messages.length, 21);
  await compactHistory('group:1', messages.filter((m) => m.id !== 1));
  assert.equal(calls, 2, 'removed messages invalidate summary');
  const { buildTriggerBlock } = await import('../src/prompt.js');
  assert.ok(buildTriggerBlock([{ id: 1, ts: Date.now(), senderName: '甲', text: '@二号机', atMe: true }], {}).includes('@我'));
  const { buildToolDefs, executeTool } = await import('../src/tools.js');
  const sticker = await executeTool(buildToolDefs(), { stickers: { find: async () => ({ id: 'gif', localFile: '/local/开心.gif', desc: '开心' }) } }, 'get_sticker_image', { stickerId: 'gif' });
  assert.equal(sticker.isError, undefined);
  assert.ok(sticker.content.includes('按文件名'));
  assert.equal(calls, 2, 'local GIF does not call vision');
  console.log('PASS: compressed history, recent originals, summary reuse, recall invalidation, @ identity, filename-only GIF');
} finally { globalThis.fetch = original; fs.rmSync(dir, { recursive: true, force: true }); }
