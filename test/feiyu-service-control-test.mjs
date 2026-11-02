import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createServiceControl } from '../skills/feiyu-voice/service-manager.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-service-'));
try {
  fs.mkdirSync(path.join(root, 'macos'));
  fs.writeFileSync(path.join(root, 'macos/start.sh'), '# fixture');
  fs.mkdirSync(path.join(root, '.runtime/voice-service'), { recursive: true });
  fs.writeFileSync(path.join(root, '.runtime/voice-service/api_key.txt'), 'fixture-secret');
  let ready = false, live = false, spawns = 0, tick = Date.now();
  let child;
  const options = { platform: 'darwin', now: () => tick, alive: () => live, fetch: async (url, opts) => {
    assert.equal(url, 'http://127.0.0.1:9880/v1/capabilities');
    assert.equal(opts.headers.Authorization, 'Bearer fixture-secret');
    if (!ready) throw new Error('fetch failed');
    return Response.json({ tts: [{ voice: 'feiyu', available: true, runtime_backend: 'mlx', styles: ['cute', 'gentle'] }] });
  }, spawnProcess: (cmd, args, opts) => {
    assert.equal(cmd, '/bin/zsh'); assert.deepEqual(args, [path.join(root, 'macos/start.sh')]);
    assert.equal(opts.detached, true); assert.equal(opts.cwd, root); assert.equal(opts.stdio[0], 'ignore');
    spawns++; live = true; child = new EventEmitter(); child.pid = 12345; child.unref = () => {}; return child;
  } };
  const control = createServiceControl(root, options);
  assert.equal((await control.status()).state, 'offline');
  await Promise.all([control.start(), control.start()]);
  assert.equal(spawns, 1, 'concurrent start clicks launch once');
  assert.equal((await control.status()).state, 'starting');
  const reloaded = createServiceControl(root, options);
  await reloaded.start(); assert.equal(spawns, 1, 'plugin reload retains startup ownership');
  ready = true;
  assert.equal((await control.status()).state, 'ready');
  assert.match((await control.status()).message, /mlx/);
  await control.start(); assert.equal(spawns, 1, 'ready service is reused');
  ready = false; tick += 601000;
  assert.equal((await control.status()).state, 'error');
  await control.start(); assert.equal(spawns, 1, 'timed out live process is not duplicated');
  live = false; child.emit('exit', 1);
  assert.equal((await control.status()).state, 'error');
  assert.match((await control.status()).message, /已退出/);
  await control.start(); assert.equal(spawns, 2, 'failed launch can be retried');
  live = false; child.emit('error', new Error('spawn error'));
  assert.match((await control.status()).message, /启动失败/);
  const noPid = createServiceControl(root, { ...options, spawnProcess: () => {
    const c = new EventEmitter(); queueMicrotask(() => c.emit('error', new Error('no pid'))); return c;
  } });
  assert.equal((await noPid.start()).state, 'error');
  assert.ok(!JSON.stringify(await noPid.status()).includes('fixture-secret'), 'status never exposes key');
  const windows = createServiceControl(root, { ...options, platform: 'win32', spawnProcess: () => { throw new Error('Windows must not launch zsh'); } });
  ready = false; live = false;
  assert.deepEqual((await windows.status()).disabledActions, ['start']);
  assert.equal((await windows.start()).state, 'offline');
  ready = true;
  assert.equal((await windows.status()).state, 'ready', 'manually started Windows service is usable');
  console.log('PASS: offline, authenticated readiness, fixed launch, double click, hot reload, timeout, failure, retry and secret redaction');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
