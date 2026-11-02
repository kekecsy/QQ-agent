// Reprocess the existing local sample without model inference or QQ sends.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitSpeech, joinSpeechWavs } from '../skills/feiyu-voice/speech-segments.js';
import { compactSpeechClip, joinTimedSpeech } from '../skills/feiyu-voice/speech-timing.js';
import { encodeQqVoice } from '../src/voice-silk.js';
const root=fileURLToPath(new URL('../../feiyu/',import.meta.url));
const parts=splitSpeech('这图不错 偷了。不过俺翼男主我就记得个鹫介 别的没印象了');
const jobs=path.join(root,'.runtime/voice-service/jobs'),found=new Map();
for(const name of fs.readdirSync(jobs).sort((a,b)=>fs.statSync(path.join(jobs,a)).mtimeMs-fs.statSync(path.join(jobs,b)).mtimeMs)) {
 try {
  const dir=path.join(jobs,name),r=JSON.parse(fs.readFileSync(path.join(dir,'request.json'),'utf8')).request;
  if(r.style==='gentle'&&parts.some(p=>p.text===r.text)&&!found.has(r.text)&&fs.existsSync(path.join(dir,'audio.wav')))found.set(r.text,fs.readFileSync(path.join(dir,'audio.wav')));
 }catch{}
}
if(found.size!==parts.length)throw new Error('Original sample jobs missing');
const source=parts.map(p=>found.get(p.text)),clips=source.map(compactSpeechClip);
const original=joinSpeechWavs(source,parts),output=joinTimedSpeech(clips,parts);
const folder=path.join(root,'outputs'),file=path.join(folder,'segmented-gentle-compact.wav');
fs.writeFileSync(file,output);fs.writeFileSync(file.replace('.wav','.silk'),await encodeQqVoice(file));
const report={originalSeconds:(original.length-44)/48000,compactSeconds:(output.length-44)/48000,
 clips:clips.map((c,i)=>({text:parts[i].text,removedMs:c.removedMs,leadingMs:c.leadingMs,trailingMs:c.trailingMs})),
 boundaryMs:parts.slice(0,-1).map((p,i)=>Math.max(p.pauseMs,clips[i].trailingMs+clips[i+1].leadingMs)),qqNetworkSend:false};
if(report.compactSeconds>=report.originalSeconds-1)throw new Error('Long sample gaps were not shortened');
fs.writeFileSync(file.replace('.wav','.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
