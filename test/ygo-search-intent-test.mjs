import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ygo-search-intent-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const originalFetch = globalThis.fetch;
try {
  const { setup, internals } = await import('../skills/ygo-ruling/index.js');
  fs.mkdirSync(path.join(dir, 'ygo-ruling'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ygo-ruling/cards.json'), JSON.stringify({
    1: { id: 1, cn_name: '测试检索怪兽', text: { types: '[怪兽|效果] 魔法师/暗\n[★8] 2000/2000', desc: '从卡组把1张永续陷阱卡加入手卡。' }, data: { type: 33, level: 8 } },
    2: { id: 2, cn_name: '测试分段效果怪兽', text: { types: '[怪兽|效果] 龙/光\n[★8] 2500/3000', desc: '①：从卡组把1只怪兽加入手卡。②：从卡组把1张永续陷阱卡表侧表示放置。' }, data: { type: 33, level: 8 } },
    3: { id: 3, cn_name: '测试检索陷阱', text: { types: '[陷阱]', desc: '从卡组把1只8星怪兽加入手卡。' }, data: { type: 4, level: 0 } }
  }));
  globalThis.fetch = async () => { throw Error('intent test must stay offline'); };
  const defs = new Map();
  setup({ config: () => ({}), log: () => {}, registerTool: def => defs.set(def.id, def) });
  const tool = defs.get('search_card');
  const wrong = await tool.execute({}, { keyword: '永续陷阱', level: 8, effectKeywords: ['永续陷阱', '加入手卡'], detail: 'list' });
  assert.match(wrong.content, /没有匹配结果/, 'do not silently discard a name constraint');
  assert.match(wrong.content, /先检查keyword/, 'empty results must diagnose the mistaken name field before widening the effect/level');
  assert.match(wrong.content, /省略keyword/, 'offer the actual filter-only path');
  const right = await tool.execute({}, { level: 8, effectKeywords: ['永续陷阱', '加入手卡'], detail: 'list' });
  assert.ok(!right.isError);
  assert.match(right.content, /测试检索怪兽/);
  assert.match(right.content, /测试分段效果怪兽/, 'AND terms can occur in different effects; retrieval alone is not a semantic verdict');
  const objectLevel = await tool.execute({}, { effectKeywords: ['8星', '加入手卡'], detail: 'list' });
  assert.match(objectLevel.content, /测试检索陷阱/, 'described effect target must not become a level constraint on the searched card');
  assert.match(tool.parameters.properties.keyword.description, /省略/);
  assert.match(tool.description, /首次调用/);
  const prompt = internals.playbook();
  for (const rule of ['首次调用先拆条件', '无卡名或系列名时省略keyword', '被检索', '从卡组', '加入手卡', '同一效果', '不放宽明确的星级']) {
    assert.ok(prompt.includes(rule), `missing search planning rule: ${rule}`);
  }
  console.log('PASS: filter-only retrieval, field-first empty-result guidance, effect-object binding and first-call prompt contract');
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(dir, { recursive: true, force: true });
}
