import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../scripts/study-ocg-rules.mjs';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocg-resume-'));
const originalFetch = globalThis.fetch;
const names = ['HOME', 'NVIDIA_API_KEY', 'NVIDIA_API_KEY_2', 'NVIDIA_API_KEY_3'];
const env = Object.fromEntries(names.map((n) => [n, process.env[n]]));
try {
  process.env.HOME = dir;
  process.env.NVIDIA_API_KEY = 'nvapi-fixture-not-real';
  delete process.env.NVIDIA_API_KEY_2;
  delete process.env.NVIDIA_API_KEY_3;
  const source = path.join(dir, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'x_content_list.json'), JSON.stringify([
    { type: 'text', text: '3.6 连锁基础', text_level: 2, page_idx: 0 },
    { type: 'text', text: '代价在发动时支付。', page_idx: 0 }
  ]));
  let requests = 0;
  globalThis.fetch = async (_url, init) => {
    requests++;
    const body = JSON.parse(init.body);
    assert.equal(body.chat_template_kwargs.thinking, false);
    assert.equal(body.response_format.type, 'json_object');
    assert.ok(!init.body.includes('nvapi-'), 'key must never enter model messages');
    if (requests === 1) return new Response('', { status: 429, headers: { 'retry-after': '0.001' } });
    const synthesis = body.messages[0].content.startsWith('只整理');
    const value = synthesis
      ? { checks: [{ check: '区分代价和处理', rule_ids: ['001-r1'] }], conflicts: [], excluded: [] }
      : { section_title: '连锁基础', rules: [{ statement: '代价在发动时支付', scope: 'OCG', preconditions: [], exceptions: [], timing: '发动', sources: [{ block_id: 'p1-b1', quote: '代价在发动时支付。' }] }], distinctions: [], uncertainties: [] };
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }], usage: { total_tokens: 10 } }));
  };
  const out = path.join(dir, 'out');
  const args = ['--source', source, '--out', out, '--run', '--synthesize'];
  await main(args);
  assert.equal(requests, 3, '429 is retried, not dropped');
  await main(args);
  assert.equal(requests, 3, 'resume reuses valid chapter and synthesis checkpoints');
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'knowledge.json'), 'utf8')).complete, true);
  for (const name of fs.readdirSync(out).filter((n) => n.endsWith('.json'))) assert.ok(!fs.readFileSync(path.join(out, name), 'utf8').includes('nvapi-fixture-not-real'));
  console.log('PASS: 429 backoff, JSON/NVIDIA parameters, resumable checkpoints, synthesis references and no persisted keys');
} finally {
  globalThis.fetch = originalFetch;
  for (const n of names) { if (env[n] === undefined) delete process.env[n]; else process.env[n] = env[n]; }
  fs.rmSync(dir, { recursive: true, force: true });
}
