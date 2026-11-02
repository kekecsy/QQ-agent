import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseYgoCommand } from '../src/ygo-command.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ygo-command-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const { hitKeyword, resolveContextTier, resolveReach } = await import('../src/prompt.js');
const { internals: skill } = await import('../skills/ygo-ruling/index.js');
const quick = await import('../plugins/ygo-quick-card/index.js');

const valid = ['查卡 青眼白龙', '裁定 灰流丽能否无效增殖的G', '查卡  青眼白龙'];
const invalid = ['查卡', '裁定', '查卡 ', '裁定   ', '查卡青眼白龙', '裁定：灰流丽', '查卡\t青眼白龙', ' 查卡 青眼白龙', '\n裁定 灰流丽', '@小鲸鱼 查卡 青眼白龙', '请查卡 青眼白龙', '今天聊到了裁定 灰流丽', '游戏王这张卡的效果能不能发动'];
for (const text of [...valid, ...invalid]) {
  const expected = valid.includes(text);
  assert.equal(Boolean(parseYgoCommand(text)), expected, text);
  assert.equal(hitKeyword(text, ['查卡', '裁定']), expected, text);
  assert.equal(skill.ygoSignal(text), expected, text);
  const triggerEntries = [{ text, atMe: false }];
  assert.equal(resolveContextTier({ cfg: { contextTier: 2, keywords: ['查卡', '裁定'] }, triggerEntries }).shouldRespond, expected, text);
  assert.equal(resolveReach({ chatKey: 'group:1', cfg: { store: { keywords: ['查卡', '裁定'] } }, triggerEntries }).keyword, expected, text);
}
assert.equal(hitKeyword('聊点天气吧', ['天气']), true, 'other keywords keep their original behavior');
assert.equal(resolveContextTier({ cfg: { contextTier: 2, keywords: ['裁定'] }, triggerEntries: [{ text: '裁定', atMe: false }, { text: ' 普通内容', atMe: false }] }).shouldRespond, false, 'must not synthesize commands across messages');

await quick.setup({ config: () => ({}), fetch: async () => { throw Error('must not fetch'); }, log: () => {}, warn: () => {}, isEnabledForChat: () => true });
try {
  const engine = quick.internals.engine;
  let plans = 0;
  engine.plan = () => { plans++; return null; };
  const orch = { runningChats: new Set(), pendingWake: new Set() };
  for (const text of [...invalid, '裁定 灰流丽', '青眼白龙']) quick.internals.route(orch, () => {}, 'group:1', { text });
  assert.equal(plans, 0, 'fast lane must never inspect ordinary chat or ruling commands');
  quick.internals.route(orch, () => {}, 'group:1', { text: '查卡 青眼白龙' });
  assert.equal(plans, 1);
} finally { quick.dispose?.(); fs.rmSync(dir, { recursive: true, force: true }); }
console.log('PASS: strict command parsing, keyword wake, reach, skill rules and fast-lane gating');
