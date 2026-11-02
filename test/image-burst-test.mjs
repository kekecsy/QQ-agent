import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-burst-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const savedFetch = globalThis.fetch;
let orch;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const { updateConfig } = await import('../src/config.js');
  const { ChatStore } = await import('../src/store.js');
  const { MemoryStore } = await import('../src/memory.js');
  const { SessionRegistry } = await import('../src/sessions.js');
  const { Orchestrator } = await import('../src/orchestrator.js');
  updateConfig({ api: { model: 'test', baseUrl: 'https://model.example/v1' }, store: { contextSliderPos: 100 }, wakeDelayMs: 1, imageReply: { enabled: true, quietMs: 80, maxWaitMs: 200 }, sessionRetryAttempts: 0 });
  const store = new ChatStore();
  const sessions = new SessionRegistry();
  let observed = 0;
  let release;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'finish', type: 'function', function: { name: 'finish', arguments: '{"summary":"一起看完，不需要回复"}' } }] } }] }));
  };
  orch = new Orchestrator({ store, sessions, memory: new MemoryStore(), stickers: { sync: async () => ({ entries: [] }) }, sender: {}, onebot: { getGroupInfo: async () => ({ group_name: 'test' }) }, observeImage: async () => {
    observed++;
    await new Promise((resolve) => { release = resolve; });
    return '第1张：猫猫虫搬砖，表达打工很累。';
  } });
  const image = store.appendIncoming('group:1', { mid: 1, senderId: 'a', text: '[图片]', media: [{ kind: 'image', url: 'https://image.example/1.gif' }], atMe: false });
  orch.onIncoming('group:1', image);
  await sleep(20);
  assert.equal(observed, 1, 'separate image observation starts during the quiet window');
  assert.equal(requests.length, 0, 'main chat does not immediately react to image');
  const text1 = store.appendIncoming('group:1', { mid: 2, senderId: 'a', text: '先别管表情，今天累死了', atMe: false });
  orch.onIncoming('group:1', text1);
  await sleep(40);
  const text2 = store.appendIncoming('group:1', { mid: 3, senderId: 'a', text: '终于把工作做完了', atMe: false });
  orch.onIncoming('group:1', text2);
  release();
  await sleep(40);
  assert.equal(requests.length, 0, 'same sender followups extend the quiet window');
  for (let i = 0; i < 50 && !sessions.listSummaries().some((s) => s.status === 'noreply'); i++) await sleep(10);
  assert.equal(requests.length, 1, 'one combined decision, not separate image and text sessions');
  const prompt = requests[0].messages[1].content;
  assert.match(prompt, /猫猫虫搬砖/);
  assert.match(prompt, /今天累死了/);
  assert.match(prompt, /工作做完了/);
  assert.equal(store.unreadCount('group:1'), 0);
  await orch.abortAll();
  let lateRelease;
  requests.length = 0;
  orch = new Orchestrator({ store, sessions, memory: new MemoryStore(), stickers: { sync: async () => ({ entries: [] }) }, sender: {}, onebot: { getGroupInfo: async () => ({ group_name: 'test' }) }, observeImage: async () => {
    await new Promise((resolve) => { lateRelease = resolve; });
    return '晚到的旧表情观察';
  } });
  const slowImage = store.appendIncoming('group:2', { mid: 10, senderId: 'b', text: '[图片]', media: [{ kind: 'image', url: 'https://image.example/slow.gif' }] });
  orch.onIncoming('group:2', slowImage);
  for (let i = 0; i < 50 && !requests.length; i++) await sleep(10);
  assert.equal(requests.length, 1, 'slow vision cannot hold the chat past the quiet threshold');
  assert.match(requests[0].messages[1].content, /后台识图/);
  lateRelease();
  await sleep(20);
  assert.equal(requests.length, 1, 'late observation never opens a second reply session');
  assert.equal(store.findByMid('group:2', 10).visualSummary, '晚到的旧表情观察');
  await orch.abortAll();

  const deliveries = [];
  let modelRound = 0;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    modelRound++;
    let name = 'finish';
    let args = { summary: 'done' };
    if (modelRound === 1) {
      const followup = store.appendIncoming('group:3', { mid: 22, senderId: 'c', text: '别管刚才那个表情，我要说的是明天加班' });
      orch.onIncoming('group:3', followup);
      name = 'send_message'; args = { messages: '这是旧图片回复，不应发送' };
    } else if (modelRound === 2) {
      assert.match(JSON.stringify(body.messages), /明天加班/);
      name = 'send_message'; args = { messages: '明天还得加班啊' };
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: `call-${modelRound}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }));
  };
  orch = new Orchestrator({ store, sessions, memory: new MemoryStore(), stickers: { sync: async () => ({ entries: [] }) }, onebot: { getGroupInfo: async () => ({ group_name: 'test' }) }, sender: { sendTextBatch: async (_key, texts) => {
    deliveries.push(...texts); return { sent: texts.map((text) => ({ text, messageId: 99 })), failed: [] };
  } } });
  store.appendIncoming('group:3', { mid: 21, senderId: 'c', text: '[图片]', media: [{ kind: 'image', url: 'https://image.example/1.gif' }], atMe: false });
  await orch.wake('group:3');
  assert.deepEqual(deliveries, ['明天还得加班啊'], 'unmentioned image sender followup replaces stale draft before any delivery');
  assert.equal(store.unreadCount('group:3'), 0);
  assert.equal(modelRound, 3);

  console.log('PASS: background observation, bounded image wait, same-sender batching, one combined session');
} finally {
  globalThis.fetch = savedFetch;
  await orch?.abortAll();
  fs.rmSync(dir, { recursive: true, force: true });
}
