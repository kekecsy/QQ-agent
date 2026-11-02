import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waiting-queue-'));
process.env.QQ_AGENT_DATA_DIR = dir;
try {
  const { updateConfig } = await import('../src/config.js');
  const { Orchestrator } = await import('../src/orchestrator.js');
  const { SessionRegistry } = await import('../src/sessions.js');
  updateConfig({ api: { model: 'test' }, maxConcurrentRuns: 1 });
  const sessions = new SessionRegistry();
  const store = { peekUnread: () => [{ text: '[图片]', senderName: 'test' }] };
  const o = new Orchestrator({ store, sessions, onebot: {} });
  o.runningChats.add('private:busy');
  const waiting = sessions.create({ chatKey: 'private:1', status: 'waiting', trigger: store.peekUnread() });
  await o.wake('private:1', { waitingSessionId: waiting.id });
  try {
    assert.equal(o.pendingSessions.get('private:1'), waiting.id, 'full queue must retain original waiting session');
    assert.ok(o.pendingWake.has('private:1'), 'incoming messages must not start duplicate waiters');
    o.scheduleWake('private:1', 0);
    assert.equal(sessions.current.size, 1);
  } finally { for (const timer of o.wakeTimers.values()) clearTimeout(timer); }
  console.log('PASS: saturated queue retains one waiting session');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
