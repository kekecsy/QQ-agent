import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gifToFrameSheet } from '../src/gif-to-video.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gif-vision-test-'));
try {
  const file = path.join(dir, 'motion.gif');
  execFileSync(process.platform === 'darwin' ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg',
    ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=6:duration=2', '-y', file]);
  const result = await gifToFrameSheet(fs.readFileSync(file));
  assert.equal(result.isGif, true);
  assert.equal(result.gifSheet, true);
  assert.match(result.dataUrl, /^data:image\/jpeg;base64,/);
  const bytes = Buffer.from(result.dataUrl.split(',')[1], 'base64');
  assert.ok(bytes.length < 2 * 1024 * 1024);
  const sheet = path.join(dir, 'sheet.jpg');
  fs.writeFileSync(sheet, bytes);
  const probe = JSON.parse(execFileSync(process.platform === 'darwin' ? '/opt/homebrew/bin/ffprobe' : 'ffprobe', ['-v', 'quiet', '-show_streams', '-of', 'json', sheet]));
  assert.equal(probe.streams[0].width, 1440);
  assert.equal(probe.streams[0].height, 960);
  assert.equal(await gifToFrameSheet(Buffer.from('not a gif')), null);
  console.log('PASS: real ffmpeg GIF temporal contact sheet, size limits and non-GIF rejection');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
