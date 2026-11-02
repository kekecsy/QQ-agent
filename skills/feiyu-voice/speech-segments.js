// Spaces between English words/numbers stay within the same phrase.
export function splitSpeech(text, pauseMs = 180) {
  const chars = [...String(text || '').trim()];
  const parts = [];
  let buffer = '';
  const flush = (pause) => {
    if (/[\p{L}\p{N}]/u.test(buffer)) parts.push({ text: buffer.trim(), pauseMs: pause });
    buffer = '';
  };
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (/\s/u.test(c)) {
      let next = i + 1;
      while (next < chars.length && /\s/u.test(chars[next])) next++;
      if (!chars.slice(i, next).some(ch => ch === '\n' || ch === '\r') && /[A-Za-z0-9]$/.test(buffer) && /^[A-Za-z0-9]/.test(chars[next] || '')) buffer += ' ';
      else flush(pauseMs);
      i = next - 1;
    } else if (/[，,。！？!?；;：:、…\.]/u.test(c) && !(c === '.' && /[0-9]/.test(chars[i - 1] || '') && /[0-9]/.test(chars[i + 1] || ''))) {
      buffer += c;
      // Keep repeated punctuation and closing quotes attached to this phrase.
      while (i + 1 < chars.length && /[，,。！？!?；;：:、…\.」』”’）)\]】]/u.test(chars[i + 1])) buffer += chars[++i];
      flush(/[。！？!?…\.]/u.test(c) ? Math.max(pauseMs, 260) : pauseMs);
    } else buffer += c;
  }
  flush(0);
  return parts;
}

function readPcm(wav) {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('分句音频不是 WAV');
  let format, audio;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const name = wav.toString('ascii', offset, offset + 4), size = wav.readUInt32LE(offset + 4);
    if (offset + 8 + size > wav.length) throw new Error('分句 WAV 数据不完整');
    const chunk = wav.subarray(offset + 8, offset + 8 + size);
    if (name === 'fmt ') format = chunk;
    if (name === 'data') audio = chunk;
    offset += 8 + size + (size % 2);
  }
  if (!format || format.length < 16 || !audio?.length || format.readUInt16LE(0) !== 1
      || format.readUInt16LE(2) !== 1 || format.readUInt32LE(4) !== 24000 || format.readUInt16LE(14) !== 16 || audio.length % 2) {
    throw new Error('分句拼接需要 24kHz 单声道 PCM16 WAV');
  }
  return audio;
}

export function joinSpeechWavs(wavs, parts) {
  if (!wavs.length || wavs.length !== parts.length) throw new Error('分句音频数量不匹配');
  const chunks = [];
  wavs.forEach((wav, i) => {
    chunks.push(readPcm(wav));
    if (i + 1 < wavs.length) chunks.push(Buffer.alloc(Math.round(24000 * parts[i].pauseMs / 1000) * 2));
  });
  const size = chunks.reduce((sum, c) => sum + c.length, 0);
  if (size > 24000 * 2 * 30) throw new Error('拼接语音超过 QQ 的30秒上限，请缩短回复');
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(size + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(size, 40);
  return Buffer.concat([header, ...chunks]);
}

// Overlap HTTP submission/polling with at most two jobs in flight. The resident
// MLX engine still serializes GPU inference on its dedicated worker thread.
export async function synthesizeParts(parts, synthesize) {
  const output = new Array(parts.length);
  let cursor = 0, failure;
  await Promise.all(Array.from({ length: Math.min(2, parts.length) }, async () => {
    while (!failure && cursor < parts.length) {
      const i = cursor++;
      try { output[i] = await synthesize(parts[i].text); } catch (e) { failure = e; }
    }
  }));
  if (failure) throw failure;
  return output;
}
