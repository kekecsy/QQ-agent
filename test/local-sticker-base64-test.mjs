import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-base64-'));
process.env.QQ_AGENT_DATA_DIR = tmp;
try {
  const folder = path.join(tmp, 'sticker-images');
  fs.mkdirSync(folder);
  const file = path.join(folder, 'test.gif');
  const bytes = Buffer.from('GIF89aFixture');
  fs.writeFileSync(file, bytes);
  const { SendQueue } = await import('../src/sender.js');
  const calls = [];
  const sender = new SendQueue({ onebot: { sendSticker: async (_kind, _id, ref) => { calls.push(ref); return { message_id: 1 }; } }, store: { appendSelf() {} } });
  await sender.sendSticker('group:1', { id: 'test', url: pathToFileURL(file).href });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].startsWith('base64://'));
  assert.deepEqual(Buffer.from(calls[0].slice(9), 'base64'), bytes);
  await assert.rejects(sender.sendSticker('group:1', { id: 'bad', url: pathToFileURL(path.join(tmp, 'config.json')).href }), /受控目录/);
  assert.equal(calls.length, 1);
  console.log('PASS: one Base64 call, unchanged GIF bytes, controlled-directory checks');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
