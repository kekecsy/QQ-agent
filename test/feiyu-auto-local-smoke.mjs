// Live local TTS, fake QQ sink: no chat messages are sent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'feiyu-auto-local-'));
process.env.QQ_AGENT_DATA_DIR=temp;
try {
 const voice=await import('../skills/feiyu-voice/index.js');
 const auto=await import('../plugins/feiyu-voice-auto/index.js');
 const { deliverTextReply }=await import('../src/text-delivery.js');
 voice.setup({config:()=>({style:'cute',maxChars:50,cooldownMinutes:0,proactive:false}),registerTool(){},fetch:globalThis.fetch,isEnabledForChat:()=>true});
 auto.setup({config:()=>({probability:100}),isEnabledForChat:()=>true,capability:(name,args)=>voice.providers[name]?.(args)});
 let recorded=0, texts=0;
 const ctx={chatKey:'private:local-smoke',session:{sent:[]},sender:{sendMedia:async(_key,segs)=>{
  if(segs[0].type!=='record'||!segs[0].data.file.startsWith('base64://'))throw new Error('Invalid voice segment');
  recorded++;return {message_id:1};
 },sendTextBatch:async()=>{texts++;return {sent:[],failed:[]};}}};
 const started=Date.now();
 const r=await deliverTextReply(ctx,['这次回复随机变成肥鱼语音啦。'],{}, {getCapabilityProviders:()=>[{skillId:'feiyu-voice-auto',fn:auto.deliver}],recordError(_id,e){throw e;}});
 if(!r.handled||recorded!==1||texts!==0)throw new Error('Probability reply did not render to voice exactly once');
 console.log('PASS: 100% probability -> actual local MLX TTS -> Tencent SILK -> fake sender,',((Date.now()-started)/1000).toFixed(2),'seconds; no QQ send');
} finally { fs.rmSync(temp,{recursive:true,force:true}); }
