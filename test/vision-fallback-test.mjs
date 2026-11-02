import assert from 'node:assert/strict';
import { callVisionWithFallback, visionEndpointKey } from '../src/vision-fallback.js';
import * as pool from '../skills/account-pool/index.js';
import { gifVisionEndpoint, GIF_VISION_MODEL } from '../src/gif-vision.js';

const primary = { baseUrl: 'https://primary.example/v1', model: 'vision-a', apiKey: 'test' };
const accounts = [
  { ...primary, id: 'a', key: 'test', visionModel: primary.model, enabled: true },
  { ...primary, id: 'a2', key: 'test2', visionModel: primary.model, enabled: true },
  { id: 'b', baseUrl: 'https://backup.example/v1', model: 'text', visionModel: 'vision-b', key: 'test3', enabled: true },
  { id: 'text-only', baseUrl: 'https://text.example/v1', model: 'text', key: 'test4', enabled: true }
];
pool.setup({ config: () => ({ strategy: 'fixed', accounts }), log: () => {} });
const calls = [];
const feedbacks = [];
const run = (call) => callVisionWithFallback({ primary,
  pick: (excluded) => pool.pickAccount({ vision: true, visionBaseUrl: primary.baseUrl, visionModel: primary.model, ...excluded }),
  feedback: (result) => { feedbacks.push(result); pool.recordLatency(result.accountId, 10); }, call });
const result = await run(async (target, timeout) => {
  assert.ok(timeout > 0 && timeout <= 30000);
  calls.push(target.id);
  if (target.id === 'a') throw new DOMException('timeout', 'TimeoutError');
  return { message: { content: 'backup observed image' } };
});
assert.deepEqual(calls, ['a', 'b']);
assert.equal(result.message.content, 'backup observed image');
assert.deepEqual(feedbacks.map((f) => f.ok), [false, true]);
pool.resetStats();
calls.length = 0;
await assert.rejects(run(async (target) => { calls.push(target.id); return { message: { content: '' } }; }), /未返回内容/);
assert.deepEqual(calls, ['a', 'b']);
assert.equal(visionEndpointKey({ ...primary, baseUrl: primary.baseUrl + '/' }), visionEndpointKey(primary));
let attempts = 0;
await assert.rejects(callVisionWithFallback({ primary, pick: ({ excludeEndpoints }) => {
  const n = excludeEndpoints.length;
  return { id: `other-${n}`, baseUrl: `https://other-${n}.example/v1`, model: 'vision' };
}, call: async () => { attempts++; throw new Error('offline'); } }), /offline/);
assert.equal(attempts, 3);
let clock = 0;
attempts = 0;
await assert.rejects(callVisionWithFallback({ primary, now: () => clock,
  pick: () => ({ baseUrl: 'https://one.example/v1', model: 'vision' }),
  call: async () => { attempts++; clock += 90000; throw new Error('deadline'); } }), /deadline/);
assert.equal(attempts, 1);
const gif = gifVisionEndpoint({ api: { model: 'main' }, providers: [{ id: 'orca', baseURL: 'https://api.orcarouter.ai/v1' }], dshProviderKeys: { orca: 'test-secret' } });
assert.equal(gif.model, GIF_VISION_MODEL);
assert.equal(gif.apiKey, 'test-secret');
assert.equal(gifVisionEndpoint({ providers: [{ id: 'x', baseURL: 'https://api.orcarouter.ai.evil.test/v1', apiKey: 'test' }] }), null);
assert.equal(gifVisionEndpoint({ providers: [{ id: 'orca', baseURL: 'https://api.orcarouter.ai/v1' }] }), null);
const order = [];
await callVisionWithFallback({ primary, preferred: gif, pick: () => primary,
  call: async (target) => { order.push(target.model); if (target === gif) throw new Error('offline'); return { message: { content: 'fallback' } }; } });
assert.deepEqual(order, [GIF_VISION_MODEL, primary.model]);
console.log('PASS: timeout/empty response fallback, distinct vision channels, feedback and bounded attempts');
