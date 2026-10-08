import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ygo-sync-test-'));
process.env.QQ_AGENT_DATA_DIR = path.join(tmp, 'data');
const originalFetch = globalThis.fetch;
try {
  const mod = await import('../skills/ygo-ruling/data-sync.mjs');
  const raw = JSON.stringify({ 4007: { id: 89631139, cid: 4007, cn_name: '青眼白龙', text: { desc: 'test' } } });
  assert.equal(mod.validateCards(raw), 1);
  assert.throws(() => mod.validateCards('{}'));
  fs.writeFileSync(path.join(tmp, 'cards.json'), raw);
  execFileSync('zip', ['-q', path.join(tmp, 'cards.zip'), 'cards.json'], { cwd: tmp });
  const zip = fs.readFileSync(path.join(tmp, 'cards.zip'));
  let downloads = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('.md5')) return new Response(JSON.stringify(createHash('md5').update(raw).digest('hex')));
    downloads++;
    return new Response(zip);
  };
  const wait = async () => { while (mod.syncStatus().running) await new Promise((r) => setTimeout(r, 10)); };
  mod.startSync('cards');
  assert.equal(mod.startSync('lua').kind, 'cards');
  await wait();
  assert.equal(mod.syncStatus().error, '');
  assert.equal(mod.syncStatus().cards.count, 1);
  assert.equal(mod.searchLocalCards('青眼')[0].id, 89631139);
  assert.equal(mod.searchLocalCards('89631139')[0].cn_name, '青眼白龙');
  mod.startSync('cards');
  await wait();
  assert.equal(downloads, 1, 'unchanged checksum avoids repeat download');
  globalThis.fetch = async (url) => new Response(String(url).endsWith('.md5') ? JSON.stringify('0'.repeat(32)) : zip);
  mod.startSync('cards');
  await wait();
  assert.match(mod.syncStatus().error, /MD5/);
  assert.equal(mod.searchLocalCards('青眼').length, 1, 'failed update retains old database');
  const mirror = path.join(process.env.QQ_AGENT_DATA_DIR, 'ygo-ruling/scripts-mirror');
  fs.mkdirSync(mirror);
  fs.writeFileSync(path.join(mirror, 'manifest.json'), JSON.stringify({ totalScripts: 7 }));
  globalThis.fetch = async () => { throw new Error('offline'); };
  mod.startSync('lua');
  await wait();
  assert.equal(mod.syncStatus().lua.totalScripts, 7, 'failed sync retains old mirror');
  for (const inner of ['CardScripts-master/official', 'CardScripts-master/pre-release', 'ygopro-scripts-master']) {
    fs.mkdirSync(path.join(tmp, inner), { recursive: true });
    fs.writeFileSync(path.join(tmp, inner, 'c1.lua'), '-- fixture');
  }
  execFileSync('zip', ['-qr', path.join(tmp, 'ignis.zip'), 'CardScripts-master'], { cwd: tmp });
  execFileSync('zip', ['-qr', path.join(tmp, 'ygopro.zip'), 'ygopro-scripts-master'], { cwd: tmp });
  globalThis.fetch = async (url) => new Response(fs.readFileSync(path.join(tmp, String(url).includes('ProjectIgnis') ? 'ignis.zip' : 'ygopro.zip')));
  mod.startSync('lua');
  await wait();
  assert.equal(mod.syncStatus().error, '');
  assert.equal(mod.syncStatus().lua.totalScripts, 3);
  assert.equal(fs.readFileSync(path.join(mirror, 'official/c1.lua'), 'utf8'), '-- fixture');
  assert.equal(fs.readdirSync(path.dirname(mirror)).some((n) => n.startsWith('.sync-')), false);
  assert.throws(() => mod.startSync('invalid'));
  const { createRoutes } = await import('../src/routes.js');
  const { skillManager } = await import('../src/skills/manager.js');
  skillManager.registry.register({ manifest: { id: 'sync-test', settings: {} }, settingsActions: { actions: [{ id: 'cards' }], status: mod.syncStatus, run: mod.startSync } });
  const routes = createRoutes({ readBody: async () => ({ action: 'invalid' }) });
  const route = routes.find((r) => r.method === 'POST' && r.pattern instanceof RegExp && r.pattern.test('/api/skills/sync-test/settings-actions'));
  let code;
  await route.handler({ req: {}, res: {}, match: route.pattern.exec('/api/skills/sync-test/settings-actions'), json: (_res, status) => { code = status; } });
  assert.equal(code, 400);
  console.log('PASS: sync, checksum, offline search, duplicate jobs, failure preservation, action validation');
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(tmp, { recursive: true, force: true });
}
