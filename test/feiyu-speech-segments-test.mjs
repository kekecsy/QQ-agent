import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { splitSpeech, joinSpeechWavs, synthesizeParts } from '../skills/feiyu-voice/speech-segments.js';
const example = '这图不错 偷了。不过俺翼男主我就记得个鹫介 别的没印象了';
assert.deepEqual(splitSpeech(example).map(p => p.text), ['这图不错', '偷了。', '不过俺翼男主我就记得个鹫介', '别的没印象了']);
assert.deepEqual(splitSpeech('你好，今天不错,出去走走吧！').map(p => p.text), ['你好，', '今天不错,', '出去走走吧！']);
assert.deepEqual(splitSpeech('玩 Galgame 很开心。DeepSeek V3.5 is good!').map(p => p.text), ['玩', 'Galgame', '很开心。', 'DeepSeek V3.5 is good!']);
assert.deepEqual(splitSpeech('“好耶！”\n再见……').map(p => p.text), ['“好耶！”', '再见……']);
assert.deepEqual(splitSpeech('？？ ， ……'), []);
assert.deepEqual(splitSpeech('Hello\r\nworld').map(p => p.text), ['Hello', 'world']);
assert.deepEqual(splitSpeech('abc def 123.45').map(p => p.text), ['abc def 123.45']);
function wav(sample) {
  const header = Buffer.alloc(44), data = Buffer.alloc(480);
  for (let i = 0; i < data.length; i += 2) data.writeInt16LE(sample, i);
  header.write('RIFF'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
const joined = joinSpeechWavs([wav(100), wav(200)], [{ pauseMs: 180 }, { pauseMs: 0 }]);
assert.equal(joined.readInt16LE(44), 100);
assert.equal(joined.readInt16LE(44 + 480), 0);
assert.equal(joined.readInt16LE(44 + 480 + 8640), 200);
assert.equal(joined.length, 44 + 960 + 8640);
assert.throws(() => joinSpeechWavs([Buffer.from('bad')], [{}]), /WAV/);
assert.throws(() => joinSpeechWavs([wav(100), wav(200)], [{ pauseMs: 31000 }, {}]), /30秒/);
let inFlight = 0, maxFlight = 0;
const result = await synthesizeParts([{text:'a'}, {text:'b'}, {text:'c'}], async t => {
  maxFlight = Math.max(maxFlight, ++inFlight);
  await new Promise(r => setTimeout(r, t === 'a' ? 20 : 1));
  inFlight--; return t;
});
assert.deepEqual(result, ['a','b','c']); assert.equal(maxFlight, 2);
await assert.rejects(synthesizeParts([{text:'a'}, {text:'b'}], async t => {
  if (t === 'a') throw new Error('failed segment');
  await new Promise(r => setTimeout(r, 5)); return t;
}), /failed segment/);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-segment-'));
process.env.QQ_AGENT_DATA_DIR = dir;
try {
  const mod = await import('../skills/feiyu-voice/index.js');
  const jobs = new Map(), requested = [];
  let sends = 0;
  mod.setup({ config: () => ({cooldownMinutes:0,maxChars:80}), registerTool(){}, fetch: async (url, opts) => {
    if (String(url).endsWith('/speech')) {
      const text = JSON.parse(opts.body).text; requested.push(text);
      const id = requested.length.toString(16).padStart(32, '0'); jobs.set(id, requested.length * 100);
      return Response.json({id});
    }
    const id = /jobs\/([a-f0-9]+)/.exec(url)[1];
    return String(url).endsWith('/audio') ? new Response(wav(jobs.get(id))) : Response.json({status:'success'});
  } }, { encodeVoice: async f => { assert.ok(fs.readFileSync(f).length > 1000); return Buffer.from('silk fixture'); } });
  const file = await mod.audioFor(example, 'gentle');
  assert.deepEqual(requested, splitSpeech(example).map(p => p.text));
  const calls = requested.length;
  assert.equal(await mod.audioFor(example, 'gentle'), file); assert.equal(requested.length, calls);
  const ctx = { chatKey:'private:test', session:{sent:[]}, sender:{sendMedia:async(_key,_segments,opts)=>{
    assert.equal(opts.label, `[肥鱼语音/gentle] ${example}`); sends++; return {message_id:1};
  }} };
  const sent = await mod.sendVoice(ctx, {text:example,style:'gentle',requested:true});
  assert.equal(sent.isError, undefined); assert.equal(sends,1); assert.equal(ctx.session.sent[0].text,example);
  assert.equal(requested.length,calls,'composite cache avoids all extra inference');
  const beforeRepeat = requested.length;
  await mod.audioFor('好呀，好呀，再见。', 'cute');
  assert.equal(requested.length - beforeRepeat, 2, 'repeated phrases share a single in-flight synthesis');
  console.log('PASS: original reply boundaries, Chinese/English comma, English/decimal preservation, pause PCM/order, two in-flight jobs, failure, cache and one QQ voice/history');
} finally { fs.rmSync(dir,{recursive:true,force:true}); }
