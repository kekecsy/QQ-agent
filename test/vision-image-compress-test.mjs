import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareVisionImage } from '../src/image-compress.js';
const ff = process.platform === 'darwin' ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
const probe = process.platform === 'darwin' ? '/opt/homebrew/bin/ffprobe' : 'ffprobe';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-compress-'));
function fixture(name, filter) {
  const file = path.join(dir, name);
  execFileSync(ff, ['-v', 'error', '-f', 'lavfi', '-i', filter, '-frames:v', '1', '-y', file]);
  return fs.readFileSync(file);
}
function dimensions(result, name) {
  const file = path.join(dir, name + '.jpg');
  fs.writeFileSync(file, result.buffer);
  return JSON.parse(execFileSync(probe, ['-v', 'quiet', '-show_streams', '-of', 'json', file])).streams[0];
}
try {
  const small = fixture('small.png', 'color=white:size=128x96');
  assert.deepEqual((await prepareVisionImage(small)).buffer, small);
  const large = fixture('large.png', 'color=white:size=4000x3000');
  assert.ok(large.length < 512 * 1024, 'fixture exercises oversized pixels with small file');
  const normal = await prepareVisionImage(large);
  const normalSize = dimensions(normal, 'normal');
  assert.equal(normalSize.width, 1280);
  assert.equal(normalSize.height, 960);
  assert.ok(normal.compressed);
  const detailed = dimensions(await prepareVisionImage(large, { detailed: true }), 'detail');
  assert.equal(detailed.width, 2048);
  assert.equal(detailed.height, 1536);
  const noisy = fixture('noisy.png', 'color=gray:size=2400x1800,noise=alls=80:allf=u:all_seed=42');
  const reduced = await prepareVisionImage(noisy);
  assert.ok(reduced.buffer.length < noisy.length / 2);
  assert.ok(reduced.buffer.length <= 384 * 1024);
  assert.equal(dimensions(reduced, 'noisy-result').width, 1280);
  const gif = fixture('animated.gif', 'testsrc=size=160x120');
  assert.deepEqual((await prepareVisionImage(gif)).buffer, gif);
  console.log('PASS: small images unchanged; low-byte oversized images resized; aspect ratio; detail mode; noisy image budget; GIF preserved');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
