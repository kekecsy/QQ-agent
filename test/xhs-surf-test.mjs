import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-surf-'));
process.env.QQ_AGENT_DATA_DIR = dir;
try {
  const { loadState, saveState, chinaClock, publishDue, parseAnalysis, canCollect, collectionReasons, publicComments, readingHistory, retryableNote, selectRetryNotes, upsertNote, saveImage, readImage } = await import('../skills/xhs-surf/library.js');
  const { publishToday, relevantFeed, syncToQQ } = await import('../skills/xhs-surf/worker.js');
  assert.equal(relevantFeed({ noteCard: { displayTitle: 'Claude又被玩坏了' } }), true);
  assert.equal(relevantFeed({ noteCard: { displayTitle: '普通食谱' } }), false);
  const before = Date.parse('2026-10-13T12:59:00Z');
  const due = Date.parse('2026-10-13T13:00:00Z');
  assert.equal(chinaClock(due).hour, 21);
  assert.equal(publishDue(loadState(), { autoPost: true }, before), false);
  assert.equal(publishDue(loadState(), { autoPost: true }, due), true);
  assert.equal(publishDue(loadState(), { autoPost: true }, due + 11 * 60000), false);
  const note = { title: 'DeepSeek娘表情包', desc: '无水印 自取' };
  const analysis = parseAnalysis('{"suitable":true,"aiRelated":true,"confidence":0.9,"meaning":"无语","name":"无语"}');
  assert.equal(canCollect(note, analysis), true);
  assert.equal(canCollect(note, { ...analysis, watermark: null }), true);
  assert.equal(canCollect(note, { ...analysis, watermark: true }), true);
  assert.equal(canCollect({ title: '可爱图片', desc: '' }, analysis), true);
  assert.equal(canCollect(note, { ...analysis, suitable: false }), false);
  assert.equal(canCollect(note, { ...analysis, aiRelated: false }), false);
  assert.equal(canCollect(note, { ...analysis, confidence: 0.5 }), false);
  assert.ok(collectionReasons(note, { ...analysis, suitable: false }).some((r) => r.includes('不适合')));
  assert.throws(() => parseAnalysis('{"name":"未判断","confidence":0.9}'), /未返回完整/);
  const comments = publicComments({ user: { userId: 'author' } }, { list: [
    { content: '无水印 自取', userInfo: { userId: 'author' } },
    { content: '随便用', userInfo: { userId: 'other' } }
  ] });
  assert.deepEqual(comments.map((c) => c.authorIsPoster), [true, false]);
  assert.equal(canCollect({ title: 'DeepSeek表情', desc: '', authorCommentText: comments.filter((c) => c.authorIsPoster).map((c) => c.text).join(' ') }, analysis), true);
  const history = readingHistory({ notes: [{ title: '旧图', source: 'https://www.xiaohongshu.com/explore/123', meanings: [{ meaning: '表情含义', watermark: null, collected: false }] }], images: [] });
  assert.ok(history[0].checks[0].reasons.some((r) => r.includes('无法确认')));
  assert.equal(history[0].legacy, true);
  assert.equal(retryableNote({ imageChecks: [{ status: 'failed', reasons: ['DNS失败'] }] }), true);
  assert.equal(retryableNote({ imageChecks: [{ status: 'skipped', watermark: null }] }), true);
  assert.equal(retryableNote({ imageChecks: [{ status: 'skipped', watermark: true }] }), true, 'old policy must be re-evaluated');
  assert.equal(retryableNote({ collectionPolicy: 'suitability-v2', imageChecks: [{ status: 'skipped', suitable: false }] }), false);
  assert.equal(retryableNote({ imageChecks: [{ status: 'collected', watermark: false }] }), false);
  const queued = { notes: [
    { id: 'uncertain', lastRetryAt: 10, imageChecks: [{ status: 'skipped', watermark: null }] },
    { id: 'recent-error', lastRetryAt: 20, imageChecks: [{ status: 'failed' }] },
    { id: 'old-error', imageChecks: [{ status: 'failed' }] },
    { id: 'older-error', lastRetryAt: 5, imageChecks: [{ status: 'failed' }] }
  ] };
  assert.deepEqual(selectRetryNotes(queued).map((n) => n.id), ['old-error', 'older-error', 'recent-error']);
  const retryState = { notes: [{ id: 'same', title: 'old' }] };
  upsertNote(retryState, { id: 'same', title: 'new' });
  assert.equal(retryState.notes.length, 1);
  assert.equal(retryState.notes[0].title, 'new');
  const image = saveImage(Buffer.from('test'), 'png');
  assert.equal(readImage(image).toString(), 'test');
  assert.throws(() => readImage({ filename: '../service-token' }));
  const library = loadState(); library.images.push({ ...image, name: '测试', meaning: '含义' }); saveState(library);
  let collections = 0;
  await syncToQQ(async () => { collections++; return { emojiId: 'qq-id' }; });
  assert.equal(loadState().images[0].qqSyncStatus, 'collected');
  await syncToQQ(async () => { collections++; });
  assert.equal(collections, 1, 'confirmed QQ favorites are not recollected');
  const { updateConfig } = await import('../src/config.js');
  const { StickerManager } = await import('../src/sticker-manager.js');
  updateConfig({ sticker: { collectEnabled: true } });
  const actions = [];
  const manager = new StickerManager({ call: async (action, params) => {
    actions.push(action);
    if (action === 'add_custom_face') { assert.ok(params.file.startsWith('base64://')); return { emoji_id: 'verified-qq-favorite' }; }
    if (action === 'modify_custom_face') return {};
    throw new Error('unexpected action');
  } });
  const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);
  const favorite = await manager.collect('xhs-test', { bytes: original, note: '表情含义' });
  assert.equal(favorite.emojiId, 'verified-qq-favorite');
  assert.ok(favorite.localFile);
  await manager.collect('xhs-test', { bytes: original, note: '表情含义' });
  assert.equal(actions.filter((a) => a === 'add_custom_face').length, 1);
  const { createHash } = await import('node:crypto');
  let nativeAdds = 0;
  const native = new StickerManager({ call: async (action, params) => {
    if (action === 'get_version_info') return { app_name: 'NapCat.Onebot' };
    if (action === 'fetch_custom_face_detail') return nativeAdds ? [{ md5: createHash('md5').update(original).digest('hex'), resId: 'native-res-id' }] : [];
    if (action === 'add_custom_face') {
      assert.ok(fs.existsSync(params.file));
      assert.ok(!params.file.startsWith('base64:'));
      assert.ok(fs.readFileSync(params.file).equals(original));
      nativeAdds++; return { result: 0 };
    }
    return {};
  } }, { collectionRoot: path.join(dir, 'qq-cache') });
  const nativeFavorite = await native.collect('native-test', { bytes: original, note: '原生收藏' });
  assert.equal(nativeFavorite.emojiId, 'native-res-id');
  await native.collect('native-other-source', { bytes: original, note: '同图不同来源' });
  assert.equal(nativeAdds, 1, 'MD5 lookup avoids adding an existing native favorite again');
  let posts = 0;
  const draft = async () => ({ date: '2026-10-13', text: '公开梗总结', sources: [] });
  const post = async () => { posts++; return { sent: true, tid: 'receipt' }; };
  await publishToday({ autoPost: true }, { draft, post, now: () => due });
  assert.equal(loadState().posts['2026-10-13'].status, 'published');
  await publishToday({ autoPost: true }, { draft, post, now: () => due });
  assert.equal(posts, 1);
  const state = loadState(); state.posts = {}; saveState(state);
  await assert.rejects(publishToday({ autoPost: true }, { draft, now: () => due, post: async () => { posts++; throw new Error('timeout'); } }), /timeout/);
  assert.equal(loadState().posts['2026-10-13'].status, 'needs-review');
  await publishToday({ autoPost: true }, { draft, post, now: () => due });
  assert.equal(posts, 2, 'unknown publication must not retry after restart');
  console.log('PASS: China21:00 window, suitability selection without watermark gate, local paths, QQ collection receipts and restart dedup');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
