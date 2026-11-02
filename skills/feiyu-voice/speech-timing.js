import { cleanSpeechEdges } from './acoustic-cleanup.js';
import { joinSpeechWavs } from './speech-segments.js';

// Trim only outside sustained speech, retaining 80ms onset / 120ms release.
// Intra-phrase pauses are never shortened here.
export function compactSpeechClip(wav) {
  const cleaned = cleanSpeechEdges(wav); // also validates PCM16/mono/24kHz
  let dataOffset, dataSize;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = wav.readUInt32LE(offset + 4);
    if (wav.toString('ascii', offset, offset + 4) === 'data') { dataOffset = offset + 8; dataSize = size; }
    offset += 8 + size + size % 2;
  }
  const count = dataSize / 2, frame = 240, levels = [];
  for (let i = 0; i < count; i += frame) {
    const end = Math.min(count, i + frame);
    let power = 0;
    for (let j = i; j < end; j++) power += wav.readInt16LE(dataOffset + j * 2) ** 2;
    levels.push(Math.sqrt(power / (end - i)));
  }
  const threshold = Math.max(...levels) * 10 ** (-24 / 20);
  let first = -1, last = -1;
  for (let i = 0; i + 2 < levels.length; i++) {
    if (threshold > 0 && levels[i] >= threshold && levels[i + 1] >= threshold && levels[i + 2] >= threshold) {
      if (first < 0) first = i;
      last = i + 2;
    }
  }
  // Very short / undetectable clips are left intact rather than risking deletion.
  if (first < 0) return { wav: cleaned, leadingMs: 0, trailingMs: 0, removedMs: 0 };
  const voiceStart = first * frame, voiceEnd = Math.min(count, (last + 1) * frame);
  const start = Math.max(0, voiceStart - 1920), end = Math.min(count, voiceEnd + 2880);
  const pcm = Buffer.from(cleaned.subarray(dataOffset + start * 2, dataOffset + end * 2));
  const fade = 144;
  for (let i = 0; i < pcm.length / 2; i++) {
    const gain = Math.max(0, Math.min(1, i / fade, (pcm.length / 2 - 1 - i) / fade));
    if (gain < 1) pcm.writeInt16LE(Math.round(pcm.readInt16LE(i * 2) * gain), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return { wav: Buffer.concat([header, pcm]), leadingMs: (voiceStart - start) / 24,
    trailingMs: (end - voiceEnd) / 24, removedMs: (count - end + start) / 24 };
}

export function joinTimedSpeech(clips, parts) {
  if (!clips.length || clips.length !== parts.length) throw new Error('分句音频数量不匹配');
  if (clips.length === 1) return clips[0].wav;
  // A punctuation pause is the total boundary budget, not silence to add on top
  // of the two clips' retained onset/release padding.
  const timing = parts.map((p, i) => ({ ...p, pauseMs: Math.max(0,
    p.pauseMs - clips[i].trailingMs - (clips[i + 1]?.leadingMs || 0)) }));
  return joinSpeechWavs(clips.map(c => c.wav), timing);
}
