import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-preflight-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const { updateConfig } = await import('../src/config.js');
const { Orchestrator } = await import('../src/orchestrator.js');
const { SessionRegistry } = await import('../src/sessions.js');
let release;
let orch;
try {
  updateConfig({ api: { model: 'test' }, store: { contextSliderPos: 30 } });
  const sessions = new SessionRegistry();
  let schedules = 0;
  let reads = 0;
  orch = new Orchestrator({
    store: { peekUnread: () => [], markAllRead: () => { reads++; return 0; } }, sessions,
    onebot: { selfId: '123', call: () => new Promise((r) => { release = r; }) }
  });
  orch.scheduleWake = () => { schedules++; };
  const waiting = sessions.create({ chatKey: 'group:1', status: 'waiting', trigger: [] });
  const work = orch.wake('group:1', { waitingSessionId: waiting.id });
  await orch.wake('group:1', { waitingSessionId: waiting.id });
  assert.equal(sessions.get(waiting.id).status, 'waiting', 'duplicate wake cannot abort the owner waiter');
  orch.onIncoming('group:1', { id: 2, text: 'next message', ts: Date.now() });
  orch.paused = true;
  release({});
  await work;
  assert.equal(schedules, 0, 'incoming during asynchronous preflight must not create a second waiter');
  assert.equal(reads, 0, 'pause during preflight must not consume messages');
  assert.equal(sessions.get(waiting.id).status, 'aborted');
  orch.paused = false;
  const broken = sessions.create({ chatKey: 'private:broken', status: 'waiting', trigger: [] });
  orch.store.peekUnread = () => { throw new Error('preflight storage failure'); };
  await assert.rejects(() => orch.wake('private:broken', { waitingSessionId: broken.id }), /storage failure/);
  assert.equal(sessions.get(broken.id).status, 'error', 'unexpected startup failure must be visible, not stuck waiting');
  assert.equal(orch.startingChats.size, 0);
  assert.equal(orch.runningChats.size, 0);
  console.log('PASS: preflight is exclusive and respects pause after await');
} finally {
  for (const t of orch?.wakeTimers.values() || []) clearTimeout(t);
  fs.rmSync(dir, { recursive: true, force: true });
}
