import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { decode, isSilk, getDuration } from 'silk-wasm';
import { encodeQqVoice } from '../src/voice-silk.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-silk-test-'));
try {
  const input = path.join(dir, 'test.mp3');
  execFileSync(process.platform === 'darwin' ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4', '-ar', '48000', '-ac', '1', input]);
  const result = await encodeQqVoice(input);
  assert.ok(isSilk(result));
  assert.equal(result[0], 2, 'Tencent SILK prefix');
  assert.ok(getDuration(result) >= 300);
  assert.ok((await decode(result, 24000)).data.length > 1000);
  const modified = fs.statSync(`${input}.qq.silk`).mtimeMs;
  assert.deepEqual(await encodeQqVoice(input), result);
  assert.equal(fs.statSync(`${input}.qq.silk`).mtimeMs, modified, 'cached SILK reused');
  fs.writeFileSync(path.join(dir, 'bad.mp3'), 'not audio');
  await assert.rejects(encodeQqVoice(path.join(dir, 'bad.mp3')), /PCM失败/);
  console.log('PASS: MP3 to PCM to Tencent SILK, decode verification, cache reuse, invalid input rejected');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
