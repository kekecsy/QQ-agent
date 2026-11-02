import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { encode, isSilk } from 'silk-wasm';

const exec = promisify(execFile);
export async function encodeQqVoice(mp3File) {
  const file = `${mp3File}.qq.silk`;
  if (fs.existsSync(file) && fs.statSync(file).mtimeMs >= fs.statSync(mp3File).mtimeMs) {
    const cached = fs.readFileSync(file);
    if (cached.length > 16 && cached.length < 5 * 1024 * 1024 && isSilk(cached)) return cached;
  }
  const candidates = [...new Set([process.platform === 'darwin' ? '/opt/homebrew/bin/ffmpeg' : '', 'ffmpeg', 'ffmpeg.exe'].filter(Boolean))];
  let pcm;
  for (const command of candidates) {
    try {
      const result = await exec(command, ['-nostdin', '-v', 'error', '-i', mp3File, '-f', 's16le', '-ar', '24000', '-ac', '1', 'pipe:1'], { encoding: 'buffer', maxBuffer: 24000 * 2 * 30, timeout: 20000, windowsHide: true });
      pcm = result.stdout;
      break;
    } catch (e) {
      if (e.code !== 'ENOENT') throw new Error('音频转PCM失败，请检查源音频、ffmpeg及30秒时长上限');
    }
  }
  if (!pcm?.length) throw new Error('找不到可用 ffmpeg，无法生成QQ语音');
  const result = await encode(pcm, 24000);
  const buffer = Buffer.from(result.data);
  if (!isSilk(buffer) || !result.duration) throw new Error('QQ SILK 编码失败');
  fs.writeFileSync(`${file}.tmp`, buffer);
  fs.renameSync(`${file}.tmp`, file);
  return buffer;
}
