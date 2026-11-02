import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractBlocks, makeChunks, validateSummary } from '../scripts/study-ocg-rules.mjs';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocg-study-'));
try {
  for (const [part, entries] of [[1, [{ type: 'text', text: '3.6 连锁基础', text_level: 2, page_idx: 0 }, { type: 'text', text: '代价在发动时支付。', page_idx: 1 }]], [2, [{ type: 'text', text: '效果尚未处理，不提前破坏。', page_idx: 0 }, { type: 'image', img_path: 'images/a.jpg', page_idx: 1 }]]]) {
    fs.mkdirSync(path.join(dir, String(part)));
    fs.writeFileSync(path.join(dir, String(part), 'x_content_list.json'), JSON.stringify(entries));
  }
  const { sources, blocks } = extractBlocks([path.join(dir, '1'), path.join(dir, '2')]);
  assert.equal(sources[1].pageOffset, 2);
  assert.equal(blocks[2].globalPdfPage, 3);
  assert.equal(blocks[2].chapter, '3.6 连锁基础', 'chapter continues across PDF boundary');
  assert.match(blocks[3].text, /图像未识别/);
  const chunks = makeChunks(blocks, 25);
  assert.equal(chunks.flatMap((c) => c.blocks).map((b) => b.text).join(''), blocks.map((b) => b.text).join(''));
  const chunk = { blocks };
  const value = { section_title: '连锁', rules: [{ statement: '代价与处理分开', scope: 'OCG', preconditions: [], exceptions: [], timing: '发动', sources: [{ block_id: blocks[1].id, quote: '代价在发动时支付。' }] }], distinctions: [], uncertainties: [] };
  validateSummary(value, chunk);
  const fake = structuredClone(value);
  fake.rules[0].sources[0].quote = '可以在连锁处理中随时发动';
  assert.throws(() => validateSummary(fake, chunk), /引证校验失败/);
  fake.rules[0].sources[0] = { block_id: 'nonexistent', quote: '代价在发动时支付。' };
  assert.throws(() => validateSummary(fake, chunk), /引证校验失败/);
  const modified = structuredClone(blocks); modified[0].text += '修改';
  assert.notEqual(makeChunks(modified)[0].digest, makeChunks(blocks)[0].digest);
  console.log('PASS: page offsets, cross-volume chapters, complete chunking, image warnings, exact citations and cache invalidation');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
