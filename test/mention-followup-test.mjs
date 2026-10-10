import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'followup-test-'));
process.env.QQ_AGENT_DATA_DIR = tmp;
try {
  const { ChatStore } = await import('../src/store.js');
  const { followupSender } = await import('../src/followup-sender.js');
  const { Orchestrator } = await import('../src/orchestrator.js');
  const store = new ChatStore();
  const anchor = store.appendIncoming('group:1', { mid: 1, senderId: 'a', text: '@bot', atMe: true });
  store.markEntryRead('group:1', anchor.id);
  const extra = store.appendIncoming('group:1', { mid: 2, senderId: 'a', text: '补一句' });
  let sent = 0;
  const triggerEntries = [anchor];
  const sender = followupSender({ sendTextBatch: async () => { sent++; } }, { store, chatKey: 'group:1', triggerEntries, context: {} });
  await assert.rejects(sender.sendTextBatch('group:1', ['old reply']), /补一句/);
  assert.equal(sent, 0);
  assert.equal(store.findByMid('group:1', extra.mid).read, true);
  assert.equal(triggerEntries.length, 2);
  store.appendIncoming('group:1', { mid: 3, senderId: 'b', text: 'other' });
  await sender.sendTextBatch('group:1', ['revised reply']);
  assert.equal(sent, 1);

  const sessions = { current: new Map(), update() {} };
  const o = new Orchestrator({ store, sessions, onebot: {}, sender: {} });
  o.pendingWake.add('group:1');
  const now = Date.now();
  o.mentionWaits.set('group:1', { senderId: 'a', until: now + 100, maxUntil: now + 8000 });
  o.onIncoming('group:1', { senderId: 'b' });
  assert.equal(o.mentionWaits.get('group:1').until, now + 100);
  o.onIncoming('group:1', { senderId: 'a' });
  assert.ok(o.mentionWaits.get('group:1').until >= now + 1900);
  o.mentionWaits.get('group:1').maxUntil = now + 500;
  o.onIncoming('group:1', { senderId: 'a' });
  assert.equal(o.mentionWaits.get('group:1').until, now + 500);
  console.log('PASS: same-sender wait extension, total cap, pre-send revision, other-sender isolation');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
