// Conservative edge-noise suppression for generated PCM16 speech. All voiced
// samples stay untouched; no noise profile is estimated from possible speech.
export function cleanSpeechEdges(wav) {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('降噪需要 WAV 音频');
  let format, dataOffset, dataLength;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const name = wav.toString('ascii', offset, offset + 4), size = wav.readUInt32LE(offset + 4);
    if (offset + 8 + size > wav.length) throw new Error('降噪 WAV 数据不完整');
    if (name === 'fmt ') format = wav.subarray(offset + 8, offset + 8 + size);
    if (name === 'data') { dataOffset = offset + 8; dataLength = size; }
    offset += 8 + size + (size % 2);
  }
  if (!format || format.length < 16 || format.readUInt16LE(0) !== 1 || format.readUInt16LE(2) !== 1
      || format.readUInt32LE(4) !== 24000 || format.readUInt16LE(14) !== 16 || !dataLength || dataLength % 2) {
    throw new Error('降噪需要 24kHz 单声道 PCM16 WAV');
  }
  const count = dataLength / 2, frameSize = 240;
  const levels = [];
  for (let first = 0; first < count; first += frameSize) {
    let power = 0;
    const end = Math.min(count, first + frameSize);
    for (let i = first; i < end; i++) power += wav.readInt16LE(dataOffset + 2 * i) ** 2;
    levels.push(Math.sqrt(power / (end - first)));
  }
  const threshold = Math.max(...levels) * 10 ** (-24 / 20);
  let firstVoice = -1, lastVoice = -1;
  for (let i = 0; i + 2 < levels.length; i++) {
    if (threshold > 0 && levels[i] >= threshold && levels[i + 1] >= threshold && levels[i + 2] >= threshold) {
      if (firstVoice < 0) firstVoice = i;
      lastVoice = i + 2;
    }
  }
  // Retain 160ms before onset and 200ms after the last sustained voice. Fricative
  // consonants and breaths adjacent to speech must not be mistaken for silence.
  const head = firstVoice < 0 ? 0 : Math.max(0, firstVoice * frameSize - 3840);
  const tail = lastVoice < 0 ? count : Math.min(count, (lastVoice + 1) * frameSize + 4800);
  const floor = 10 ** (-18 / 20), ramp = 720, fade = 144;
  const out = Buffer.from(wav);
  for (let i = 0; i < count; i++) {
    let gain = 1;
    if (i < head) gain = floor + (1 - floor) * Math.max(0, 1 - (head - i) / ramp);
    else if (i >= tail) gain = floor + (1 - floor) * Math.max(0, 1 - (i - tail) / ramp);
    gain *= Math.max(0, Math.min(1, i / fade, (count - 1 - i) / fade));
    if (gain < 1) out.writeInt16LE(Math.round(wav.readInt16LE(dataOffset + 2 * i) * gain), dataOffset + 2 * i);
  }
  return out;
}
