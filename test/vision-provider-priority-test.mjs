import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vision-priority-'));
process.env.QQ_AGENT_DATA_DIR=dir;
const savedFetch=globalThis.fetch;
let manager, savedProviders;
try {
 const {updateConfig}=await import('../src/config.js');
 const {skillManager}=await import('../src/skills/manager.js'); manager=skillManager;
 const {getImagePartsOrVideo}=await import('../src/tools.js');
 updateConfig({api:{vision:true},subagent:{enabled:true,mode:'memes',provider:'',visionProvider:'chosen',visionModel:'chosen-vl'},providers:[{id:'chosen',baseURL:'https://openrouter.ai/api/v1'}],dshProviderKeys:{chosen:'fixture'}});
 savedProviders=manager.getCapabilityProviders;
 let picked=0; const models=[];
 manager.getCapabilityProviders=function(name,...args){
  if(name==='llm.endpoint-pick')return [{fn:()=>{picked++;return {baseUrl:'https://pool.example/v1',model:'old-vl',apiKey:'fixture'};}}];
  return savedProviders.call(this,name,...args);
 };
 globalThis.fetch=async(url,opts)=>{assert.deepEqual(JSON.parse(opts.body).reasoning,{enabled:false},'vision off mode must disable reasoning rather than use a minimal thinking budget');models.push(JSON.parse(opts.body).model);return Response.json({choices:[{message:{content:'蓝色背景，红色圆形，CHECK 827'}}]});};
 const result=await getImagePartsOrVideo('测试图',[{dataUrl:'data:image/png;base64,fixture'}],{store:{recent:()=>[]},chatKey:'private:test'});
 assert.deepEqual(models,['chosen-vl'],'explicit vision choice must precede unrelated pool accounts');
 assert.equal(picked,0);
 assert.match(JSON.stringify(result),/827/);
 console.log('PASS: real image-tool path prefers configured vision model before account pool');
}finally{
 globalThis.fetch=savedFetch;if(manager&&savedProviders)manager.getCapabilityProviders=savedProviders;
 fs.rmSync(dir,{recursive:true,force:true});
}
