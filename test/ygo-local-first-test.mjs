import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ygo-local-first-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const savedFetch = globalThis.fetch;
try {
  const { queryLocalCards, localCardDatabaseVersion } = await import('../src/ygo-card-database.js');
  const { QuickCard } = await import('../plugins/ygo-quick-card/logic.js');
  const { internals } = await import('../skills/ygo-ruling/index.js');
  assert.equal(queryLocalCards('青眼'), null);
  const file = path.join(dir, 'ygo-ruling/cards.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cards = { 4007: { id: 89631139, cn_name: '青眼白龙', jp_name: '青眼の白龍', text: { desc: 'test', types: '通常怪兽' } } };
  fs.writeFileSync(file, JSON.stringify(cards));
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('offline'); };
  const quick = new QuickCard({ settings: () => ({ cacheTtlMin: 60 }), fetchImpl: globalThis.fetch, searchLocal: queryLocalCards, databaseVersion: localCardDatabaseVersion });
  assert.equal((await quick.resolve('青眼白龙')).cards[0].id, '89631139');
  assert.equal((await internals.searchYgocdb('青眼白龙', 100)).length, 1);
  assert.equal(queryLocalCards('4007')[0].cn_name, '青眼白龙', 'CID may be the dictionary key');
  assert.equal(queryLocalCards('青眼の白龍').length, 1);
  assert.equal((await quick.resolve('不存在的卡')).cards.length, 0);
  assert.deepEqual(await internals.searchYgocdb('不存在的卡', 100), []);
  assert.equal(requests, 0, 'installed local database must avoid API calls even on misses');
  cards[4007].cn_name = '青眼白龙更新';
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(cards));
  fs.renameSync(`${file}.tmp`, file);
  assert.equal((await quick.resolve('青眼白龙')).cards[0].cn_name, '青眼白龙更新', 'update invalidates query cache');
  fs.rmSync(file);
  await assert.rejects(() => internals.searchYgocdb('青眼', 100), /offline/);
  assert.equal(requests, 1, 'without a local library the online fallback remains available');
  console.log('PASS: skill and fast lane use local cards without API, observe updates, preserve online fallback before installation');
} finally {
  globalThis.fetch = savedFetch;
  fs.rmSync(dir, { recursive: true, force: true });
}
