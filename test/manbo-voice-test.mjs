import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manbo-test-'));
process.env.QQ_AGENT_DATA_DIR = tmp;
try {
  const mod = await import('../skills/manbo-voice/index.js');
  let calls = 0;
  let sent = 0;
  let unsafe = false;
  let failSend = false;
  let settings = {};
  mod.setup({ config: () => settings, registerTool() {}, fetch: async (url) => {
    if (String(url).includes('/apis/')) { calls++; return new Response(JSON.stringify({ code: 200, url: unsafe ? 'http://127.0.0.1/private' : 'https://media.milorapart.top/voice/test.mp3' })); }
    return new Response(Buffer.from('ID3test-audio'));
  } });
  assert.throws(() => mod.validateText('a'.repeat(51)));
  assert.throws(() => mod.validateText('sk-orca-' + 'a'.repeat(26)));
  const ctx = { chatKey: 'group:1', sender: { sendMedia: async (_key, segments) => {
    if (failSend) throw new Error('send failed');
    assert.equal(segments[0].type, 'record');
    assert.ok(segments[0].data.file.startsWith('base64://'));
    sent++;
  } } };
  assert.equal((await mod.sendVoice(ctx, { text: '曼波' })).isError, undefined);
  assert.equal(sent, 1);
  assert.equal((await mod.sendVoice(ctx, { text: '再说一句' })).isError, true);
  assert.equal(calls, 1);
  assert.equal((await mod.sendVoice({ ...ctx, chatKey: 'group:2' }, { text: '曼波' })).isError, undefined);
  assert.equal(calls, 1, 'reuse cached audio across chats');
  unsafe = true;
  assert.equal((await mod.sendVoice({ ...ctx, chatKey: 'group:3' }, { text: '新文案' })).isError, true);
  unsafe = false;
  failSend = true;
  assert.equal((await mod.sendVoice({ ...ctx, chatKey: 'group:4' }, { text: '发送失败测试' })).isError, true);
  const usage = JSON.parse(fs.readFileSync(path.join(tmp, 'manbo-voice/usage.json')));
  assert.equal(usage.chats['group:4'], undefined);
  settings = { proactive: false };
  assert.equal((await mod.sendVoice({ ...ctx, chatKey: 'group:5' }, { text: '曼波' })).isError, true);
  settings = { maxGenerationsPerDay: 0 };
  assert.equal((await mod.sendVoice({ ...ctx, chatKey: 'group:6' }, { text: '未缓存' })).isError, true);
  console.log('PASS: voice segment, caching, per-chat cooldown, quota, privacy, URL restriction, failed-send accounting');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
