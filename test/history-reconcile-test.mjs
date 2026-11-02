import assert from 'node:assert/strict';
import { createHistoryReconciler } from '../src/history-reconcile.js';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let calls = 0;
let active = 0;
const reconciler = createHistoryReconciler(async () => {
  assert.equal(active++, 0);
  calls++;
  await sleep(10);
  active--;
}, { delays: [0, 2, 4] });
reconciler.start();
await sleep(65);
assert.equal(calls, 3, 'retry after an initially stale history response');
reconciler.start();
reconciler.cancel();
await sleep(20);
assert.equal(calls, 3, 'disconnect cancels pending reconciliation');
console.log('PASS: bounded history retries, serialized requests and disconnect cancellation');
