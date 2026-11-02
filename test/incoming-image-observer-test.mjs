import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incoming-observer-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const savedFetch = globalThis.fetch;
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
try {
  const { updateConfig } = await import('../src/config.js');
  const { ChatStore } = await import('../src/store.js');
  const { IncomingImageObserver, imageReplyTiming } = await import('../src/incoming-images.js');
  const { observeIncomingImages, buildToolDefs, executeTool } = await import('../src/tools.js');
  const { Orchestrator } = await import('../src/orchestrator.js');
  const { SessionRegistry } = await import('../src/sessions.js');
  updateConfig({ api: { model: 'main-model', vision: true }, subagent: { visionProvider: 'vision', visionModel: 'separate-vision' }, providers: [{ id: 'vision', baseURL: 'https://vision.example/v1' }], dshProviderKeys: { vision: 'test-key' }, imageReply: { enabled: true, quietMs: 4000, maxWaitMs: 12000 }, store: { contextSliderPos: 100 } });
  const store = new ChatStore();
  fs.mkdirSync(path.join(dir, 'sticker-images'));
  const file = path.join(dir, 'sticker-images', 'source.png');
  fs.writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  const image = (mid) => store.appendIncoming('group:1', { mid, senderId: 'a', text: '[图片]', media: [{ kind: 'image', url: `file://${file}` }] });
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'separate-vision');
    assert.equal(body.tools, undefined);
    assert.ok(!JSON.stringify(body.messages).includes('senderId'));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"note":"猫疑惑地歪头","tags":["疑惑"],"usage":"反应表情"}' } }] }));
  };
  const events = [];
  const observer = new IncomingImageObserver({ store, analyze: observeIncomingImages, emit: (...args) => events.push(args) });
  const first = image(1);
  observer.observe('group:1', first);
  observer.observe('group:1', first);
  while (observer.isPending('group:1', 1)) await tick();
  assert.equal(calls, 1);
  assert.match(store.findByMid('group:1', 1).visualSummary, /猫疑惑/);
  assert.ok(events.every(([event]) => event === 'chat-update'), 'observation completion never schedules or sends');
  const cached = await executeTool(buildToolDefs(), { store, chatKey: 'group:1' }, 'get_message_images', { messageId: 1 });
  assert.equal(JSON.parse(cached.content).cached, true);
  assert.equal(calls, 1, 'manual viewing reuses background summary');

  const releases = [];
  let started = 0;
  const bounded = new IncomingImageObserver({ store, analyze: async () => {
    started++;
    await new Promise((resolve) => releases.push(resolve));
    return '迟到的观察';
  } });
  const pending = [image(2), image(3), image(4)];
  for (const entry of pending) bounded.observe('group:1', entry);
  assert.equal(started, 2, 'vision work is globally bounded to two simultaneous jobs');
  const pendingResult = await executeTool(buildToolDefs(), { store, chatKey: 'group:1', imageObserver: bounded }, 'get_message_images', { messageId: 2 });
  assert.equal(JSON.parse(pendingResult.content).pending, true);
  assert.equal(calls, 1, 'in-flight observation is not duplicated by a main-model tool call');
  bounded.cancel('group:1');
  releases.forEach((release) => release());
  await tick();
  assert.equal(started, 2, 'cancel removes queued image jobs');
  assert.ok(pending.every((entry) => !store.findByMid('group:1', entry.mid).visualSummary), 'late results after cancellation are ignored');

  const sessions = new SessionRegistry();
  const orch = new Orchestrator({ store, sessions, onebot: {}, observeImage: async () => '' });
  const now = Date.now();
  const savedNow = Date.now;
  try {
    Date.now = () => now;
    orch.onIncoming('group:1', pending[0]);
    const wait = orch.imageWaits.get('group:1');
    assert.equal(wait.until, now + 4000);
    Date.now = () => now + 11000;
    orch.onIncoming('group:1', { senderId: 'other', text: '其他人的话' });
    assert.equal(wait.until, now + 4000, 'other senders do not perpetually postpone the image batch');
    orch.onIncoming('group:1', { senderId: 'a', text: '同一人还在继续说' });
    assert.equal(wait.until, now + 12000, 'quiet extension never exceeds the total cap');
  } finally { Date.now = savedNow; await orch.abortAll(); }
  assert.equal(orch.imageWaits.size, 0);
  assert.deepEqual(imageReplyTiming({}), { quietMs: 4000, maxWaitMs: 12000 });
  assert.equal(imageReplyTiming({ imageReply: { enabled: false } }), null);
  console.log('PASS: separate vision, persistent facts, no duplicate reads, bounded jobs, cancellation, and total wait cap');
} finally { globalThis.fetch = savedFetch; fs.rmSync(dir, { recursive: true, force: true }); }
