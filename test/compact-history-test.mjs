import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-history-'));
process.env.QQ_AGENT_DATA_DIR = dir;
try {
  const { formatHistoryEntries, buildPastState, buildTriggerBlock, resolveContextTier } = await import('../src/prompt.js');
  const { ChatStore } = await import('../src/store.js');
  const { updateConfig } = await import('../src/config.js');
  updateConfig({ store: { historyCount: 0 } });
  const ts = new Date('2026-10-26T18:03:00+08:00').getTime();
  const messages = [
    { id: 1, mid: 11, senderId: '101', senderName: '甲', ts, text: '第一句' },
    { id: 2, mid: 12, senderId: '101', senderName: '甲', ts: ts + 1000, text: '第二句' },
    { id: 3, mid: 13, senderId: '202', senderName: '乙', ts: ts + 2000, text: '第三句' },
    { id: 4, mid: 14, senderId: '202', senderName: '乙', ts: ts + 60000, text: '[图片]', media: [{ kind: 'image', url: 'https://example.com/a' }] },
  ];
  const lines = formatHistoryEntries(messages);
  assert.equal(lines.length, messages.length);
  assert.equal(lines.join('\n').match(/QQ:101/g).length, 1);
  assert.match(lines[0], /甲\(QQ:101\)/);
  assert.doesNotMatch(lines[1], /甲|18:03/);
  assert.match(lines[2], /乙\(QQ:202\)：第三句/);
  assert.doesNotMatch(lines[2], /18:03/);
  assert.match(lines[3], /18:04/);
  assert.match(lines[3], /#14/);
  assert.doesNotMatch(lines[3], /乙/);
  const twin = formatHistoryEntries([{ ...messages[0], senderName: '重名' }, { ...messages[1], senderId: '303', senderName: '重名' }]).join('\n');
  assert.match(twin, /重名\(QQ:101\)/);
  assert.match(twin, /重名\(QQ:303\)/);
  const switched = formatHistoryEntries([...messages.slice(0, 3), { ...messages[0], text: '又回来了' }]);
  assert.equal(switched.join('\n').match(/QQ:101/g).length, 2);
  assert.match(switched[3], /甲\(QQ:101\)：又回来了/);
  assert.doesNotMatch(switched.join('\n'), /本段身份表/);
  const renamed = formatHistoryEntries([messages[0], { ...messages[1], senderName: '新名字' }]);
  assert.doesNotMatch(renamed[1], /QQ:|新名字/);
  const trigger = buildTriggerBlock(messages.slice(0, 2), { selfNickname: '', chatKey: 'group:1' });
  assert.match(trigger, /#11/);
  assert.match(trigger, /#12/);
  assert.equal(trigger.match(/QQ:101/g).length, 1);
  const store = new ChatStore();
  for (let i = 0; i < 650; i++) store.appendIncoming('group:1', { ...messages[0], mid: 1000 + i, text: `消息${i}`, ts: ts + i });
  const all = buildPastState(store, 'group:1');
  assert.equal(all.count, 650);
  assert.equal(buildPastState(store, 'group:1', { limit: 0 }).count, 650);
  assert.equal(buildPastState(store, 'group:1', { limit: 600 }).count, 600);
  assert.equal(resolveContextTier({ isPrivate: true }).count, 0);
  updateConfig({ store: { historyCount: 80 } });
  assert.equal(buildPastState(store, 'group:1').count, 80);
  console.log('PASS: repeated time/speaker omitted; identity mapping and duplicate names; message IDs; unlimited history beyond 500 and explicit finite window');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
