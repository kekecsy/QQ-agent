import assert from 'node:assert/strict';
import { bilibiliSearch } from '../src/bilibili-search.js';
const direct = await bilibiliSearch('Claude 梗', { fetchImpl: async (url, options) => {
  assert.equal(url.hostname, 'api.bilibili.com');
  assert.equal(url.searchParams.get('keyword'), 'Claude 梗');
  assert.equal(options.headers.Cookie, undefined);
  return Response.json({ code: 0, data: { result: [{ title: '<em>Claude</em> 梗', author: 'UP', description: '介绍', bvid: 'BV1test' }, { bvid: '../../bad' }] } });
}, search: async () => { throw new Error('Should not fallback'); } });
assert.equal(direct.source, 'bilibili');
assert.equal(direct.results.length, 1);
assert.equal(direct.results[0].title, 'Claude 梗');
const fallback = await bilibiliSearch('公开梗', { fetchImpl: async () => new Response('<html>blocked</html>'), search: async (query) => {
  assert.equal(query, 'site:bilibili.com 公开梗');
  return { answer: 'unverified', results: [{ title: '梗', snippet: '摘要', url: 'https://www.bilibili.com/video/BV1test' }, { url: 'https://bilibili.com.evil.example/video' }, { url: 'https://example.com' }] };
} });
assert.equal(fallback.source, 'web-search-site-filter');
assert.equal(fallback.results.length, 1);
assert.equal(fallback.answer, undefined);
await assert.rejects(bilibiliSearch(''), /不能为空/);
console.log('PASS: B站搜索解析、直连失败回退、域名过滤、无Cookie');
