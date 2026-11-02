import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ygo-rule-knowledge-'));
process.env.QQ_AGENT_DATA_DIR = dir;
try {
  const { searchRuleBook } = await import('../skills/ygo-ruling/rule-knowledge.mjs');
  assert.equal(searchRuleBook(['发动']).isError, true, 'missing book is explicit');
  const folder = path.join(dir, 'ygo-ruling/rule-study/2026-10-22');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'manifest.json'), '{}');
  const relevant = { id: 'p2-b1', chapter: '5.3 破坏', type: 'text', text: '怪兽发动无效并破坏的效果，需要核对其是否在场上。', part: 2, localPdfPage: 99, globalPdfPage: 299 };
  fs.writeFileSync(path.join(folder, 'source-blocks.json'), JSON.stringify([
    { ...relevant, id: 'front', chapter: '前言' },
    { ...relevant, id: 'other', chapter: '4.9 誓约' }, relevant, { ...relevant, id: 'duplicate' }
  ]));
  const result = searchRuleBook(['发动无效并破坏', '场上'], 5, '5.3');
  assert.ok(result.content.includes('【p2-b1】'));
  assert.ok(result.content.includes('第2册PDF第99页（合并第299页）'));
  assert.ok(!result.content.includes('【duplicate】'));
  assert.ok(!result.content.includes('【other】'));
  assert.ok(!result.content.includes('【front】'));
  assert.ok(searchRuleBook(['不存在的关键词']).content.includes('没有命中'));
  assert.equal(searchRuleBook(['发动'], 5, '../data').isError, true);
  assert.equal(searchRuleBook(['x']).isError, true);
  const ruling = await import('../skills/ygo-ruling/index.js');
  const tools = new Map();
  ruling.setup({ config: () => ({}), log: () => {}, registerTool: (def) => tools.set(def.id, def) });
  assert.ok(ruling.internals.LEAN_TOOLS.includes('ygo-ruling__search_rules'));
  const throughTool = await tools.get('search_rules').execute({}, { keywords: ['发动无效并破坏'], chapter: '5.3', limit: 1 });
  assert.ok(throughTool.content.includes('【p2-b1】'), 'registered skill tool invokes the actual local reader');
  console.log('PASS: local source retrieval, page provenance, chapter filtering, deduplication and safe missing-data behavior');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
