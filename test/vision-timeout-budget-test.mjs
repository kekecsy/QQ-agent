import assert from 'node:assert/strict';
import { callVisionWithFallback, visionTimeoutBudget } from '../src/vision-fallback.js';
const primary = { baseUrl: 'https://integrate.api.nvidia.com/v1', model: 'deepseek-ai/deepseek-v4.1-flash' };
const budget = visionTimeoutBudget({ subagent: {} });
assert.equal(budget.perAttemptTimeoutMs, 90000);
assert.equal(budget.totalTimeoutMs, 180000);
const result = await callVisionWithFallback({ primary, ...budget, call: async (_target, timeout) => {
  if (timeout < 43547) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  return { message: { content: 'observed screenshot' } };
} });
assert.equal(result.message.content, 'observed screenshot');
assert.deepEqual(visionTimeoutBudget({ subagent: {} }, { gif: true }), { perAttemptTimeoutMs: 30000, totalTimeoutMs: 90000 });
assert.deepEqual(visionTimeoutBudget({ subagent: { visionTimeoutMs: 60000, visionTotalTimeoutMs: 120000 } }), { perAttemptTimeoutMs: 60000, totalTimeoutMs: 120000 });
let clock = 0;
const limits = [];
await assert.rejects(callVisionWithFallback({ primary, ...budget, now: () => clock,
  pick: ({ excludeEndpoints }) => ({ baseUrl: `https://endpoint-${excludeEndpoints.length}.example/v1`, model: 'vision' }),
  call: async (_target, timeout) => { limits.push(timeout); clock += timeout; throw Error('timeout'); }
}), /timeout/);
assert.deepEqual(limits, [90000, 90000], 'total budget bounds the whole fallback, not each key separately');
console.log('PASS: observed 43.5s latency fits ordinary-image budget; GIF limits and whole-request bound retained');
