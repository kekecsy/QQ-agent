import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-auto-test-'));
process.env.QQ_AGENT_DATA_DIR = temp;
try {
  const auto = await import('../plugins/feiyu-voice-auto/index.js');
  const voice = await import('../skills/feiyu-voice/index.js');
  const { deliverTextReply } = await import('../src/text-delivery.js');
  const { buildToolDefs, executeTool } = await import('../src/tools.js');
  const { skillManager } = await import('../src/skills/manager.js');
  let chance = 100, selected = true, manualEnabled = true, fail = false, rolls = 0, generations = 0, disablesWhileEncoding = false;
  voice.setup({ config: () => ({ maxChars: 50, cooldownMinutes: 0, proactive: false }), isEnabledForChat: () => manualEnabled,
    registerTool() {}, fetch: async (url) => {
      if (String(url).endsWith('/speech')) { generations++; if (fail) throw new Error('TTS unavailable'); return Response.json({ id: 'a'.repeat(32) }); }
      if (String(url).endsWith('/audio')) { const bytes = Buffer.alloc(100); bytes.write('RIFF'); bytes.writeUInt32LE(92,4); bytes.write('WAVEfmt ',8);
        bytes.writeUInt32LE(16,16); bytes.writeUInt16LE(1,20); bytes.writeUInt16LE(1,22); bytes.writeUInt32LE(24000,24);
        bytes.writeUInt32LE(48000,28); bytes.writeUInt16LE(2,32); bytes.writeUInt16LE(16,34); bytes.write('data',36); bytes.writeUInt32LE(56,40); return new Response(bytes); }
      return Response.json({ status: 'success' });
    }
  }, { encodeVoice: async () => { if (disablesWhileEncoding) selected = false; return Buffer.from('test-SILK'); } });
  auto.setup({ config: () => ({ probability: chance }), isEnabledForChat: () => selected, warn() {},
    capability: (name, args) => voice.providers[name]?.(args) }, { rng: () => { rolls++; return .25; } });
  let serial = 0;
  const newCtx = () => {
    const sent = [];
    return { chatKey: `group:${++serial}`, session: { id: String(serial), sent: [] }, emit() {}, sent,
      sender: {
        sendMedia: async (_key, segs) => { assert.equal(segs[0].type, 'record'); sent.push('voice'); return { message_id: serial }; },
        sendTextBatch: async (_key, texts) => { sent.push('text'); return { sent: texts.map(text => ({ text, at: 'now', messageId: serial })), failed: [] }; }
      }
    };
  };
  const manager = { getCapabilityProviders: () => selected ? [{ skillId: 'feiyu-voice-auto', fn: auto.deliver }] : [], recordError() {} };
  const reply = (ctx, messages = ['你好呀'], options) => deliverTextReply(ctx, messages, options, manager);
  let ctx = newCtx(); assert.equal((await reply(ctx)).delivery, 'voice'); assert.deepEqual(ctx.sent, ['voice']);
  await reply(ctx); assert.deepEqual(ctx.sent, ['voice', 'text'], 'one probability attempt per session');
  chance = 0; ctx = newCtx(); await reply(ctx); assert.deepEqual(ctx.sent, ['text']);
  chance = 25; ctx = newCtx(); await reply(ctx); assert.deepEqual(ctx.sent, ['text'], 'random equals threshold is a miss');
  const count = rolls; await reply(ctx); assert.equal(rolls, count, 'no reroll after a miss');
  chance = 26; ctx = newCtx(); await reply(ctx); assert.deepEqual(ctx.sent, ['voice']);
  chance = 100;
  for (const messages of [['a'.repeat(51)], ['https://example.com'], ['```js\nx()\n```'], ['。。。']]) {
    ctx = newCtx(); await reply(ctx, messages); assert.deepEqual(ctx.sent, ['text']);
  }
  for (const options of [{ atUserId: 123 }, { replyToMessageId: 123 }]) {
    ctx = newCtx(); await reply(ctx, ['你好'], options); assert.deepEqual(ctx.sent, ['text']);
  }
  ctx = newCtx(); auto.hooks['after-response']({ session: ctx.session, response: { message: { tool_calls: [{ function: { name: 'feiyu-voice__send_voice' } }] } } });
  await reply(ctx); assert.deepEqual(ctx.sent, ['text'], 'explicit voice batch skips auto voice');
  fail = true; ctx = newCtx(); await reply(ctx, ['合成失败测试']); assert.deepEqual(ctx.sent, ['text'], 'TTS failure falls back once to original text'); fail = false;
  manualEnabled = false; ctx = newCtx(); await reply(ctx); assert.deepEqual(ctx.sent, ['text']); manualEnabled = true;
  disablesWhileEncoding = true; ctx = newCtx(); await reply(ctx); assert.deepEqual(ctx.sent, ['text'], 'switching off during synthesis prevents voice send');
  disablesWhileEncoding = false; selected = true;
  // Execute the real send_message entry: voice must be recorded exactly once.
  const previous = skillManager.getCapabilityProviders;
  skillManager.getCapabilityProviders = (name) => name === 'message.deliver-text' ? manager.getCapabilityProviders() : [];
  try {
    ctx = newCtx();
    const result = await executeTool(buildToolDefs(), ctx, 'send_message', JSON.stringify({ messages: '真实工具入口测试' }));
    assert.ok(!result.isError, result.content);
    assert.deepEqual(ctx.sent, ['voice']);
    assert.equal(ctx.session.sent.length, 1);
    assert.equal(ctx.session.sent[0].type, 'voice');
  } finally { skillManager.getCapabilityProviders = previous; }
  assert.equal(auto.probability(-1), 0); assert.equal(auto.probability(101), 100);
  console.log('PASS: 0/100/boundary probability, no reroll, scope, rich-text skips, explicit voice, failure fallback and real send_message history');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
