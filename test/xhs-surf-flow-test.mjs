import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-flow-'));
process.env.QQ_AGENT_DATA_DIR = dir;
try {
  const { surf } = await import('../skills/xhs-surf/worker.js');
  const { loadState } = await import('../skills/xhs-surf/library.js');
  const id = '1234567890abcdef12345678';
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);
  let collections = 0;
  const dependencies = {
    ensure: async () => {},
    apiRequest: async (route) => {
      if (route.endsWith('/status')) return { is_logged_in: true };
      if (route.endsWith('/search')) throw new Error('HTTP 500 context deadline exceeded');
      if (route.endsWith('/list')) return { feeds: [{ id, xsecToken: 'private-token', noteCard: { displayTitle: 'DeepSeek抱抱' } }] };
      if (route.endsWith('/detail')) return { note: { title: 'DeepSeek抱抱', desc: '可爱', imageList: [{ urlDefault: 'https://sns-webpic-qc.xhscdn.com/test' }] } };
      throw new Error('unexpected route');
    },
    fetchImage: async () => ({ buffer: png }),
    readText: async () => '公开笔记观点',
    inspectImage: async () => ({ name: '抱抱', meaning: '喜爱', suitable: true, aiRelated: true, confidence: 0.9 }),
    collectSticker: async (_id, bytes) => { assert.ok(bytes.equals(png)); collections++; return { emojiId: 'qq-confirmed' }; }
  };
  await surf({ maxNotes: 1, maxImages: 1, queries: 'DeepSeek' }, dependencies);
  const state = loadState();
  assert.equal(state.notes.length, 1);
  assert.equal(state.images.length, 1);
  assert.equal(state.images[0].qqEmojiId, 'qq-confirmed');
  assert.ok(state.lastSurfWarning.includes('改用发现'));
  assert.ok(!JSON.stringify(state).includes('private-token'));
  await surf({ maxNotes: 1, maxImages: 1, queries: 'DeepSeek' }, dependencies);
  assert.equal(collections, 1);
  console.log('PASS: search500 fallback -> discovery -> analysis -> original bytes -> QQ receipt -> persistent dedup');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
