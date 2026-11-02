import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-summary-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const savedFetch = globalThis.fetch;
try {
  const { updateConfig } = await import('../src/config.js');
  const { StickerManager } = await import('../src/sticker-manager.js');
  const { saveStickerStore, loadStickerStore, buildStickerContext, formatStickerList } = await import('../src/stickers.js');
  const { summarizeSticker, buildToolDefs, executeTool } = await import('../src/tools.js');
  updateConfig({ api: { model: 'test', vision: true }, subagent: { visionProvider: 'vision', visionModel: 'vision-model' }, providers: [{ id: 'vision', baseURL: 'https://vision.example/v1' }], dshProviderKeys: { vision: 'test-key' } });
  fs.mkdirSync(path.join(dir, 'sticker-images'));
  const file = path.join(dir, 'sticker-images', 'unknown.png');
  fs.writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  saveStickerStore([{ id: 'unknown', source: 'ai', url: `file://${file}` }]);
  let calls = 0;
  let release;
  globalThis.fetch = async (_url, options) => {
    calls++;
    const request = JSON.parse(options.body);
    assert.equal(request.model, 'vision-model');
    assert.ok(!JSON.stringify(request.messages).includes('群聊语境'));
    assert.equal(request.messages[1].content[1].type, 'image_url');
    await new Promise((resolve) => { release = resolve; });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ note: '小猫瞪眼，旁边一个问号', tags: ['疑惑'], usage: '表达没听懂、接疑惑的反应' }) } }] }));
  };
  const manager = new StickerManager({}, { describe: summarizeSticker });
  const first = manager.summarize('unknown');
  const second = manager.summarize('unknown');
  while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1, 'concurrent requests share a single vision call');
  assert.equal(a.localNote, b.localNote);
  assert.deepEqual(loadStickerStore()[0].tags, ['疑惑']);
  const restored = new StickerManager({}, { describe: () => { throw Error('cache should avoid vision'); } });
  assert.equal((await restored.summarize('unknown')).localNote, a.localNote);
  restored.entries[0].desc = '旧短标题';
  const context = buildStickerContext(restored.entries);
  assert.match(context, /小猫瞪眼/);
  assert.match(context, /适用：表达没听懂/);
  assert.equal(formatStickerList(restored.entries, '没听懂').stickers[0].usage, a.usage);

  let releaseCorrection;
  const correction = new StickerManager({}, { describe: async () => {
    await new Promise((resolve) => { releaseCorrection = resolve; });
    return { note: '模型旧观察', tags: [], usage: '' };
  } });
  const refresh = correction.summarize('unknown', { refresh: true });
  while (!releaseCorrection) await new Promise((resolve) => setTimeout(resolve, 5));
  correction.note('unknown', { note: '用户纠正：这是无语' });
  releaseCorrection();
  assert.equal((await refresh).localNote, '用户纠正：这是无语', 'late vision cannot overwrite a correction');

  let failedCalls = 0;
  const broken = new StickerManager({}, { describe: () => { failedCalls++; throw Error('vision down'); } });
  broken.entries = [{ id: 'bad', localNote: '', url: `file://${file}` }];
  await assert.rejects(broken.summarize('bad'), /vision down/);
  assert.equal(broken.descriptionPending.size, 0);
  await assert.rejects(broken.summarize('bad'), /暂未识别成功/);
  assert.equal(failedCalls, 1, 'failed analysis is bounded by cooldown');
  assert.equal(broken.entries[0].localNote, '', 'failure is never cached as content');

  saveStickerStore(Array.from({ length: 4 }, (_, i) => ({ id: `warm-${i}`, source: 'ai', url: `file://${file}` })));
  let warmCalls = 0;
  let releaseWarm;
  const warmer = new StickerManager({ call: async () => [] }, { describe: async () => {
    warmCalls++;
    if (warmCalls === 1) await new Promise((resolve) => { releaseWarm = resolve; });
    return { note: '小猫疑惑', tags: ['疑惑'], usage: '没听懂时' };
  } });
  await warmer.sync(true);
  assert.equal(warmCalls, 1, 'sync returns while vision is still pending');
  releaseWarm();
  await warmer.descriptionJob;
  assert.equal(warmCalls, 3, 'background analysis is bounded to three sequential images per sync');
  await warmer.sync(true);
  await warmer.descriptionJob;
  assert.equal(warmCalls, 4, 'next sync fills remaining unknown entries without reanalyzing cached ones');
  assert.ok(loadStickerStore().every((entry) => entry.localNote));

  let sent = 0;
  const unknown = { id: 'new', url: `file://${file}`, desc: '', localNote: '' };
  const ctx = { chatKey: 'group:1', stickers: {
    find: async () => unknown,
    summarize: async () => Object.assign(unknown, { localNote: '瞪眼问号猫', tags: ['疑惑'], usage: '不理解时' }), markUsed: () => {}
  }, sender: { sendSticker: async () => { sent++; return {}; } }, session: { sent: [] }, emit: () => {} };
  const defs = buildToolDefs();
  const blocked = await executeTool(defs, ctx, 'send_sticker', { stickerId: 'new' });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content, /瞪眼问号猫/);
  assert.equal(sent, 0, 'newly described sticker is not blindly sent before selection is reconsidered');
  const delivered = await executeTool(defs, ctx, 'send_sticker', { stickerId: 'new' });
  assert.ok(!delivered.isError, delivered.content);
  assert.equal(sent, 1);
  await assert.rejects(summarizeSticker({ id: 'outside', localFile: 'file:///etc/passwd' }), /受控目录/);
  console.log('PASS: persisted vision summaries, dedup, searchable usage, correction precedence, failure cooldown, and no blind sends');
} finally {
  globalThis.fetch = savedFetch;
  fs.rmSync(dir, { recursive: true, force: true });
}
