import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-intent-handoff-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const savedFetch = globalThis.fetch;
const planning = '是个QQ表情，看不到内容。可以不接，也可以回个表情。\n\n前面已经聊了几轮，不要再啰嗦。\n\n我选择发个表情收尾。用本地"呆"。';
let orch;
try {
  const { updateConfig } = await import('../src/config.js');
  const { ChatStore } = await import('../src/store.js');
  const { MemoryStore } = await import('../src/memory.js');
  const { SessionRegistry } = await import('../src/sessions.js');
  const { Orchestrator } = await import('../src/orchestrator.js');
  updateConfig({ api: { model: 'test', baseUrl: 'https://model.example/v1', maxRounds: 5 }, store: { contextSliderPos: 100 }, skills: {} });
  const store = new ChatStore();
  const sessions = new SessionRegistry();
  const deliveries = [];
  fs.mkdirSync(path.join(dir, 'sticker-images'));
  const stickerPath = path.join(dir, 'sticker-images', 'blank.png');
  fs.writeFileSync(stickerPath, 'test image');
  orch = new Orchestrator({ store, sessions, memory: new MemoryStore(),
    onebot: {}, stickers: { sync: async () => ({ entries: [] }), find: async () => ({ id: 'blank', desc: '呆', url: `file://${stickerPath}` }), markUsed: () => {} },
    sender: { sendTextBatch: async (_key, texts) => { deliveries.push(...texts); return { sent: texts.map(text => ({ text })), failed: [] }; }, sendSticker: async (_key, sticker) => { deliveries.push(sticker.desc); return { message_id: 42 }; } }
  });
  let serial = 0;
  const call = (name, args) => ({ content: null, tool_calls: [{ id: `call_${++serial}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  async function replay(contents, { recovery = call('send_sticker', { stickerId: 'blank' }), kind = 'private' } = {}) {
    const chatKey = `${kind}:${++serial}`;
    store.appendIncoming(chatKey, { mid: serial, senderId: 'someone', text: '[表情30]', media: [{ kind: 'face', faceId: '30' }] });
    const requests = [];
    globalThis.fetch = async (_url, opts) => {
      const body = JSON.parse(opts.body); requests.push(body);
      const scripted = requests.length <= contents.length ? contents[requests.length - 1] : recovery;
      const message = typeof scripted === 'function' ? scripted(serial) : scripted;
      return new Response(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }));
    };
    const before = deliveries.length;
    await orch.wake(chatKey);
    const session = sessions.listSummaries(100).find((s) => s.chatKey === chatKey);
    return { requests, delivered: deliveries.length - before, session };
  }
  const result = await replay([(mid) => call('get_message_images', { messageId: mid }), { content: planning }, call('send_sticker', { stickerId: 'blank' }), call('finish', { summary: 'done' })]);
  assert.equal(result.delivered, 1, 'decided sticker send must get one tool handoff instead of ending as noreply');
  assert.equal(result.requests[2].tool_choice, 'required');
  assert.ok(result.requests[2].messages.some((m) => typeof m.content === 'string' && m.content.includes('尚未调用发送工具')));
  assert.equal(result.session.status, 'done');
  const missedReply = '《我们没有翅膀》确实经典，西又葵的剧本很顶。\n\ngalgame聊起来容易上头啊，你玩到哪条线了？';
  const missed = await replay([{ content: missedReply }, call('send_message', { messages: ['你玩到哪条线了？'] }), call('finish', { summary: 'done' })]);
  assert.equal(missed.delivered, 1, 'private-chat final reply without a tool call must receive one execution reminder');
  assert.equal(missed.requests[1].tool_choice, 'required');
  assert.equal(missed.session.status, 'done');
  const groupDraft = await replay([{ content: missedReply }], { kind: 'group' });
  assert.equal(groupDraft.delivered, 0, 'ordinary group text is not automatically treated as a reply');
  assert.equal(groupDraft.requests.length, 1);
  const privateBounded = await replay([{ content: missedReply }, { content: missedReply }]);
  assert.equal(privateBounded.requests.length, 2, 'private reply recovery also has only one attempt');
  assert.equal(privateBounded.delivered, 0, 'raw final text is never copied to QQ');
  const privateDeclined = await replay([{ content: missedReply }, call('finish', { summary: '不回复' })]);
  assert.equal(privateDeclined.delivered, 0, 'private recovery can explicitly decline delivery');
  const { shouldHandoffUnsentReply } = await import('../src/tool-intent-handoff.js');
  assert.equal(shouldHandoffUnsentReply('要不要试试另一条线？也可以考虑重玩。', { isPrivate: true }), true);
  const originalPlanning = `是个QQ表情，看不到内容。可能是"乐"或无语类的。前面聊的是sudo关机梗，我回了"我又不是你的电脑"。他发个表情大概率是笑/无语。

我可以不接，也可以回个表情。这属于接梗收尾，回一张贴切的本地GIF比较自然。用"呆"或者"笑(指)"？其实他可能是乐，我回个"无语/呆"或者直接不接。

感觉可以直接发个"呆"或者"？"表情，或者干脆不回。前面已经说了好几轮了，再回有点啰嗦。但发个表情包收尾挺自然的。用"呆"。

其实"墨镜反光"之前发过了。发个"呆"吧。或者不回。

我选择发个表情收尾。用本地"呆"。`;
  const original = await replay([{ content: originalPlanning }, call('send_sticker', { stickerId: 'blank' }), call('finish', { summary: 'done' })]);
  assert.equal(original.delivered, 1, 'original reported planning trace also reaches a sending tool');
  const silent = await replay([{ content: '前面已经聊完了，这轮不回复，安静结束。' }]);
  assert.equal(silent.requests.length, 1, 'normal silence does not trigger a retry');
  assert.equal(silent.delivered, 0);
  const undecided = await replay([{ content: '可以发个呆，也可以不回。' }]);
  assert.equal(undecided.requests.length, 1, 'uncertain plans are not treated as a sending decision');
  const bounded = await replay([{ content: planning }, { content: planning }]);
  assert.equal(bounded.requests.length, 2, 'tool handoff is attempted only once');
  assert.equal(bounded.delivered, 0, 'planning text is never delivered');
  const declined = await replay([{ content: planning }, call('finish', { summary: '不接了' })]);
  assert.equal(declined.delivered, 0, 'model may choose finish during handoff');
  const completed = await replay([call('send_sticker', { stickerId: 'blank' }), { content: planning }]);
  assert.equal(completed.delivered, 1);
  assert.equal(completed.requests.length, 2, 'already delivered reply must not trigger another handoff');
  updateConfig({ api: { maxRounds: 1 } });
  const budget = await replay([{ content: planning }]);
  assert.equal(budget.requests.length, 1, 'handoff cannot exceed the configured round limit');
  const { hasUnexecutedSendDecision } = await import('../src/tool-intent-handoff.js');
  for (const text of ['我决定发一条文字。', '好，我先发个表情。', planning]) {
    assert.equal(hasUnexecutedSendDecision(text), true, text);
  }
  for (const text of ['', '群友说“我选择发个表情收尾”。', '我决定不回复。', '我决定发个表情。或者不回。', '可以发个呆，也可以不回。']) {
    assert.equal(hasUnexecutedSendDecision(text), false, text);
  }
  console.log('PASS: reported private reply recovered via tool, group unchanged, silence, one retry, finish, and no duplicates');
} finally {
  globalThis.fetch = savedFetch;
  for (const timer of orch?.wakeTimers.values() || []) clearTimeout(timer);
  fs.rmSync(dir, { recursive: true, force: true });
}
