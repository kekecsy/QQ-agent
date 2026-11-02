import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ygo-card-filter-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const originalFetch = globalThis.fetch;
try {
  const { queryLocalCards } = await import('../src/ygo-card-database.js');
  const { setup, internals } = await import('../skills/ygo-ruling/index.js');
  const cards = [
    { id: 1, cn_name: '磁石战士α', text: { types: '[怪兽|通常] 岩石/地\n[★4] 1400/1700', desc: '通常怪兽。' }, data: { type: 17, level: 4 } },
    { id: 2, cn_name: '电磁石战士 电磁狂神', text: { types: '[怪兽|效果|特殊召唤] 岩石/地\n[★8] 3000/2800', desc: '破坏。特殊召唤。' }, data: { type: 33554465, level: 8 } },
    { id: 3, cn_name: '电磁石战士α', text: { types: '[怪兽|效果] 岩石/地\n[★3] 1700/1100', desc: '从卡组把1只4星「磁石战士」特殊召唤。' }, data: { type: 33, level: 3 } },
    ...Array.from({ length: 106 }, (_, n) => ({ id: 100 + n, cn_name: `磁石战士候选${n}`, text: { types: '[怪兽|效果] 岩石/地\n[★4] 0/0', desc: '抽1张卡。' }, data: { type: 33, level: 4 } })),
    { id: 86289475, cn_name: '磁石战士Ω+', sc_name: '磁石战士欧米伽＋', en_name: 'Magnet Warrior Omega Plus', text: { types: '[怪兽|效果] 岩石/地\n[★4] 800/1900', desc: '这张卡在手卡·墓地存在的场合才能发动。这张卡以外的自己的手卡·场上（表侧表示）1只岩石族怪兽破坏，这张卡特殊召唤。' }, data: { type: 33, level: 4, attribute: 1, race: 256 } },
    { id: 4, cn_name: '暗战士', text: { types: '[怪兽|效果] 战士/暗\n[★4] 800/1900', desc: '地属性岩石族4星，破坏，特殊召唤。' }, data: { type: 33, level: 4 } },
    { id: 5, cn_name: '超量测试', text: { types: '[怪兽|效果|超量] 岩石/地\n[☆4] 800/1900', desc: '破坏，特殊召唤。' }, data: { type: 8388641, level: 4 } },
    { id: 6, cn_name: '连接测试', text: { types: '[怪兽|效果|连接] 岩石/地\n[LINK-4] 800/-', desc: '破坏，特殊召唤。' }, data: { type: 67108897, level: 4 } },
    { id: 7, cn_name: '磁石支援', text: { types: '[魔法]', desc: '选择地属性岩石族4星怪兽破坏，特殊召唤。' }, data: { type: 2, level: 0 } },
    { id: 8, cn_name: '灵摆测试', text: { types: '[怪兽|效果|灵摆] 岩石/地\n[★5] 100/100', pdesc: '从墓地特殊召唤。', desc: '破坏。' }, data: { type: 16777249, level: 0x01010005 } }
  ];
  const file = path.join(dir, 'ygo-ruling/cards.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(Object.fromEntries(cards.map(c => [c.id, c]))));
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('unexpected network'); };

  const filters = { attribute: '地属性', race: '岩石族', level: 4, effectKeywords: ['破坏', '特殊召唤'] };
  assert.deepEqual(queryLocalCards('磁石战士', filters).map(c => c.cn_name), ['磁石战士Ω+'], 'apply all filters before the 100-result cap');
  assert.deepEqual(queryLocalCards('', filters).map(c => c.cn_name), ['磁石战士Ω+'], 'filter-only search must not match attributes mentioned in effects or XYZ/Link ratings');
  assert.equal(queryLocalCards('磁石战士欧米伽＋', filters)[0].id, 86289475, 'existing aliases remain searchable');
  assert.equal(queryLocalCards('磁石战士', { ...filters, effectKeywords: ['手牌', '墓地', '破坏', '特殊召唤'] })[0].id, 86289475, 'common hand terminology is normalized');
  assert.equal(queryLocalCards('86289475', { level: 8 }).length, 0, 'an exact card name/password cannot override a conflicting filter');
  assert.equal(queryLocalCards('4')[0].cn_name, '暗战士');
  assert.equal(queryLocalCards('磁石战士').length, 100, 'legacy callers retain the 100-result cap');
  assert.deepEqual(queryLocalCards('', { attribute: '暗', race: '战士', level: 4 }).map(c => c.cn_name), ['暗战士']);
  assert.deepEqual(queryLocalCards('', { levelMin: 5, levelMax: 8, effectKeywords: ['破坏', '特殊召唤'] }).map(c => c.cn_name), ['电磁石战士 电磁狂神', '灵摆测试']);
  assert.equal(queryLocalCards('', { level: 5 })[0].cn_name, '灵摆测试', 'pendulum scales must not leak into level');

  const tools = new Map();
  setup({ config: () => ({ maxCandidates: 8 }), log: () => {}, registerTool: def => tools.set(def.id, def) });
  const search = args => tools.get('search_card').execute({}, args);
  const schema = tools.get('search_card').parameters;
  for (const name of Object.keys(filters)) assert.ok(schema.properties[name], `tool exposes ${name}`);
  assert.ok(!schema.required?.includes('keyword'), 'name is optional when filters are present');
  let result = await search({ keyword: '磁石战士', ...filters });
  assert.ok(!result.isError, result.content);
  assert.match(result.content, /磁石战士Ω\+/);
  assert.match(result.content, /手卡·墓地/);
  assert.doesNotMatch(result.content, /电磁狂神|没有完全同名/);
  assert.doesNotMatch(result.content, /86289475/, 'internal passwords remain hidden');
  result = await search({ ...filters, detail: 'list' });
  assert.ok(!result.isError, result.content);
  assert.match(result.content, /磁石战士Ω\+/);
  assert.match(result.content, /筛选/);
  assert.doesNotMatch(result.content, /效果文本：/, 'list mode must really remain compact even for one result');

  result = await search({ keyword: '磁石战士', detail: 'list', limit: 5, offset: 109 });
  assert.match(result.content, /磁石战士Ω\+/, 'pagination reaches candidates beyond the old first-100 cap');
  assert.doesNotMatch(result.content, /磁石战士α ｜/);
  assert.match((await search({ keyword: '磁石战士', detail: 'list' })).content, /offset=8/, 'truncation explains how to retrieve the next page');
  result = await search({ keyword: '磁石战士', level: 4, detail: 'list', limit: 5 });
  const next = JSON.parse(result.content.match(/下一页参数（保留相同查询条件）：([^\n]+)/)[1]);
  assert.deepEqual(next, { keyword: '磁石战士', level: 4, detail: 'list', limit: 5, offset: 5 }, 'next-page recipe preserves every hard filter');
  assert.ok(!(await search(next)).isError, 'the suggested next-page query is executable');
  result = await search({ keyword: '磁石战士', detail: 'full', limit: 1, offset: 109 });
  assert.match(result.content, /磁石战士Ω\+/);
  assert.doesNotMatch(result.content, /【磁石战士α】/);

  for (const args of [{}, { attribute: '不存在' }, { level: 0 }, { level: 4.5 }, { levelMin: 8, levelMax: 4 }, { level: 4, levelMin: 5 }, { effectKeywords: '破坏' }, { effectKeywords: [''] }, { keyword: '磁石战士', offset: -1 }]) {
    assert.equal((await search(args)).isError, true, `invalid query must be explicit: ${JSON.stringify(args)}`);
  }
  assert.equal(requests, 0, 'all filtered/paged searches and invalid inputs stay local');
  fs.rmSync(file);
  result = await search({ keyword: '磁石战士', level: 4 });
  assert.equal(result.isError, true);
  assert.match(result.content, /本地卡库/);
  assert.equal(requests, 0, 'never silently ignore filters or filter an incomplete remote page');
  assert.match(internals.playbook(), /effectKeywords/);
  console.log('PASS: registered card search enforces combined metadata/effect filters before limiting, paginates, and rejects invalid/unsupported queries');
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(dir, { recursive: true, force: true });
}
