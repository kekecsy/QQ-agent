import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-test-'));
process.env.QQ_AGENT_DATA_DIR = tmp;
try {
  const mod = await import('../skills/feiyu-voice/index.js');
  let calls = 0, sent = 0, polls = 0, failSend = false, failedJob = false;
  const body = Buffer.alloc(100); body.write('RIFF'); body.writeUInt32LE(92, 4); body.write('WAVEfmt ', 8);
  body.writeUInt32LE(16,16); body.writeUInt16LE(1,20); body.writeUInt16LE(1,22);
  body.writeUInt32LE(24000,24); body.writeUInt32LE(48000,28); body.writeUInt16LE(2,32); body.writeUInt16LE(16,34);
  body.write('data',36); body.writeUInt32LE(56,40);
  mod.setup({ config: () => ({ cooldownMinutes: 1 }), registerTool() {}, fetch: async (url, options) => {
    assert.ok(String(url).startsWith('http://127.0.0.1:9880/v1/'));
    assert.equal(options.redirect, 'error');
    if (String(url).endsWith('/speech')) {
      calls++;
      assert.equal(JSON.parse(options.body).voice, 'feiyu');
      return Response.json({ id: 'a'.repeat(32) });
    }
    if (String(url).endsWith('/audio')) return new Response(body);
    polls++;
    return Response.json({ status: failedJob ? 'failed' : polls % 2 ? 'running' : 'success' });
  } }, { encodeVoice: async () => Buffer.from('\x02#!SILK_V3fixture'), sleep: async () => {} });
  const ctx = (chatKey) => ({ chatKey, sender: { sendMedia: async (_key, segments) => {
    if (failSend) throw new Error('send failed');
    assert.equal(segments[0].type, 'record');
    assert.ok(segments[0].data.file.startsWith('base64://'));
    sent++;
  } } });
  assert.equal((await mod.sendVoice(ctx('g:1'), { text: '你好' })).isError, true);
  assert.equal(calls, 0);
  const args = { text: '你好呀', requested: true, style: 'cute' };
  assert.equal((await mod.sendVoice(ctx('g:1'), args)).isError, undefined);
  assert.equal(sent, 1);
  assert.equal((await mod.sendVoice(ctx('g:1'), args)).isError, true);
  assert.equal((await mod.sendVoice(ctx('g:2'), args)).isError, undefined);
  assert.equal(calls, 1, 'cache reused across chats');
  assert.equal((await mod.sendVoice(ctx('g:3'), { ...args, style: 'gentle' })).isError, undefined);
  assert.equal(calls, 2, 'different voice requires new audio');
  assert.equal((await mod.sendVoice(ctx('g:4'), { ...args, style: 'invalid' })).isError, true);
  failSend = true;
  assert.equal((await mod.sendVoice(ctx('g:5'), args)).isError, true);
  failSend = false;
  assert.equal((await mod.sendVoice(ctx('g:5'), args)).isError, undefined, 'failed send does not consume cooldown');
  failedJob = true;
  const before = sent;
  assert.equal((await mod.sendVoice(ctx('g:6'), { ...args, text: '失败测试' })).isError, true);
  assert.equal(sent, before, 'failed generation must not send');
  console.log('PASS: local authenticated API, async polling, voice-specific cache, cooldown and error propagation');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
