// Real local inference and QQ encoding, no QQ network send.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-segment-live-'));
process.env.QQ_AGENT_DATA_DIR = temp;
try {
  const voice = await import('../skills/feiyu-voice/index.js');
  const { splitSpeech } = await import('../skills/feiyu-voice/speech-segments.js');
  const { encodeQqVoice } = await import('../src/voice-silk.js');
  const { getDuration, isSilk } = await import('silk-wasm');
  voice.setup({config:()=>({}),registerTool(){},fetch:globalThis.fetch});
  const text = '这图不错 偷了。不过俺翼男主我就记得个鹫介 别的没印象了';
  const started = Date.now();
  const wav = await voice.audioFor(text, 'gentle');
  const silk = await encodeQqVoice(wav);
  if (!isSilk(silk)) throw new Error('Invalid SILK');
  const folder = fileURLToPath(new URL('../../feiyu/outputs/',import.meta.url));
  fs.mkdirSync(folder,{recursive:true});
  fs.copyFileSync(wav,path.join(folder,'segmented-gentle-acoustic.wav'));
  fs.writeFileSync(path.join(folder,'segmented-gentle-acoustic.silk'),silk);
  const report = { text, parts:splitSpeech(text), elapsedSeconds:(Date.now()-started)/1000,
    durationMs:getDuration(silk), qqNetworkSend:false, freshCache:true };
  fs.writeFileSync(path.join(folder,'segmented-gentle-acoustic.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
} finally { fs.rmSync(temp,{recursive:true,force:true}); }
