import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-queue-trigger-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const { updateConfig } = await import('../src/config.js');
const { Orchestrator } = await import('../src/orchestrator.js');
const { SessionRegistry } = await import('../src/sessions.js');
const { ChatStore } = await import('../src/store.js');
const { MemoryStore } = await import('../src/memory.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chatKey = 'group:42';
let orch;
const savedFetch = globalThis.fetch;
try {
  updateConfig({ api: { model: 'test' }, maxConcurrentRuns: 1, store: { contextSliderPos: 0 } });
  const store = new ChatStore();
  for (let i = 0; i < 501; i++) {
    store.appendIncoming(chatKey, { mid: 1000 + i, ts: Date.now() - 200_000 + i, text: 'old backlog', senderId: '1' });
  }
  const entry = store.appendIncoming(chatKey, { mid: 10, ts: Date.now() - 90_000, text: 'ordinary chat', senderId: '1' });
  const sessions = new SessionRegistry();
  orch = new Orchestrator({ store, sessions, onebot: {}, memory: new MemoryStore(), sender: {}, stickers: { sync: async () => ({ entries: [] }) } });
  orch.runningChats.add('private:busy');
  orch.scheduleWake(chatKey, 0, { verified: true, anchorEntry: entry, triggerDecision: { tier: 3, count: 80, shouldRespond: true, reason: 'original probability roll succeeded' } });
  await sleep(30);
  assert.ok(orch.pendingWake.has(chatKey));
  assert.ok(orch.verifiedWakes.has(chatKey), 'capacity retry must preserve an already successful probability roll');
  assert.equal(orch.verifiedTriggerAnchors.get(chatKey)?.id, entry.id);
  const waitingId = orch.pendingSessions.get(chatKey);
  let requests = 0;
  globalThis.fetch = async (_url, options) => {
    requests++;
    assert.match(JSON.stringify(JSON.parse(options.body).messages), /ordinary chat/);
    return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'finish', type: 'function', function: { name: 'finish', arguments: '{"reason":"test"}' } }] } }] }));
  };
  clearTimeout(orch.wakeTimers.get(chatKey));
  orch.pendingWake.delete(chatKey);
  orch.runningChats.delete('private:busy');
  orch.scheduleWake(chatKey, 0);
  for (let i = 0; i < 200 && sessions.get(waitingId)?.status !== 'noreply'; i++) await sleep(10);
  assert.equal(sessions.get(waitingId)?.status, 'noreply', 'same queued session must reach the model, not disappear');
  assert.equal(requests, 1);
  assert.equal(sessions.get(waitingId).contextReason, 'original probability roll succeeded');
  assert.equal(orch.startingChats.size, 0);
  console.log('PASS: capacity queue preserves trigger, anchor, original probability roll and session through actual model completion');
} finally {
  globalThis.fetch = savedFetch;
  for (const t of orch?.wakeTimers.values() || []) clearTimeout(t);
  fs.rmSync(dir, { recursive: true, force: true });
}
