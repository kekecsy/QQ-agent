import assert from 'node:assert/strict';
import { compactSpeechClip, joinTimedSpeech } from '../skills/feiyu-voice/speech-timing.js';
const rate = 24000;
function fixture(duration = 2) {
 const count=rate*duration,b=Buffer.alloc(44+count*2);
 b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);
 b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);
 b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(count*2,40);
 for(let i=0;i<count;i++) {
  const voice=i>=rate*.6&&i<rate*1.4;
  b.writeInt16LE(Math.round((voice?8000:70)*Math.sin(2*Math.PI*400*i/rate)),44+2*i);
 }
 return b;
}
const source=fixture(),copy=Buffer.from(source),clip=compactSpeechClip(source);
assert.deepEqual(source,copy);
assert.equal(clip.removedMs,1000);
assert.equal(clip.leadingMs,80);assert.equal(clip.trailingMs,120);
assert.equal((clip.wav.length-44)/48000,1);
assert.deepEqual(clip.wav.subarray(44+80*48,44+880*48),source.subarray(44+600*48,44+1400*48),'all sustained voice samples retained unchanged');
const joined=joinTimedSpeech([clip,clip],[{pauseMs:180},{pauseMs:0}]);
assert.equal((joined.length-44)/48000,2,'retained 200ms already covers requested 180ms boundary');
const fullStop=joinTimedSpeech([clip,clip],[{pauseMs:260},{pauseMs:0}]);
assert.equal((fullStop.length-44)/48000,2.06,'sentence boundary gets only missing 60ms');
assert.equal(clip.wav.readInt16LE(44),0);assert.equal(clip.wav.readInt16LE(clip.wav.length-2),0);
const quiet=fixture();for(let i=44;i<quiet.length;i+=2)quiet.writeInt16LE(Math.round(quiet.readInt16LE(i)/100),i);
assert.equal(compactSpeechClip(quiet).removedMs,1000,'quiet voice is preserved using relative threshold');
const silence=fixture();silence.fill(0,44);assert.equal(compactSpeechClip(silence).removedMs,0);
assert.throws(()=>compactSpeechClip(Buffer.from('bad')),/WAV/);
console.log('PASS: long edge-noise trimmed, consonant buffers/core retained, no pause stacking, sentence timing, quiet/silent clips and fades');
