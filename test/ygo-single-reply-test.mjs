import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ygo-single-'));
process.env.QQ_AGENT_DATA_DIR = dir;
try {
  const quick = await import('../plugins/ygo-quick-card/index.js');
  const sent = [];
  const sender = { sendMedia: async (_key, segments) => { sent.push(segments); }, sendTextBatch: async () => { throw Error('must not send extra text'); }, sendImage: async () => { throw Error('must not send extra image'); } };
  const result = { text: '卡名\n卡片效果', imageUrl: 'https://example.com/card.jpg', query: '卡名', kind: 'card' };
  assert.equal(await quick.internals.send({ sender }, 'group:1', { id: 1 }, result), true);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].map((s) => s.type), ['image', 'text']);
  assert.match(sent[0][1].data.text, /卡片效果/);
  let textCalls = 0;
  assert.equal(await quick.internals.send({ sender: { sendTextBatch: async (_key, texts) => { textCalls++; assert.equal(texts.length, 1); } } }, 'group:1', { id: 1 }, result), true);
  assert.equal(textCalls, 1, 'older sender falls back to one text reply without a second image');
  const ygo = await import('../skills/ygo-ruling/index.js');
  assert.match(ygo.internals.playbook(), /查卡只(?:发|回复)一条/);
  assert.ok(!ygo.internals.leanSystem().includes('唯一**能把话发到'));
  const tools = new Map();
  ygo.setup({ config: () => ({}), log: () => {}, registerTool: (def) => tools.set(def.id, def) });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => String(url).includes('/api/v0/')
    ? new Response(JSON.stringify({ result: [{ id: 12345678, cn_name: '测试卡', text: { types: '[魔法]', desc: '测试效果' } }] }))
    : new Response(Buffer.from('image'));
  sent.length = 0;
  try {
    const response = await tools.get('send_card_image').execute({ sender, chatKey: 'group:1', session: { sent: [] } }, { card: '12345678', note: '卡片完整说明' });
    assert.ok(!response.isError, response.content);
    assert.equal(sent.length, 1);
    assert.equal(sent[0][1].data.text, '\n卡片完整说明');
    assert.match(response.content, /合并为一条/);
  } finally { globalThis.fetch = originalFetch; }
  console.log('PASS: quick-card and model tool send one combined reply, with one-text legacy fallback');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
