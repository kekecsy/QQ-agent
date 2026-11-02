import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reply-image-'));
process.env.QQ_AGENT_DATA_DIR=dir;
try {
 const {ChatStore}=await import('../src/store.js');
 const {buildToolDefs,executeTool}=await import('../src/tools.js');
 const {replyImageSource}=await import('../src/reply-image-source.js');
 const store=new ChatStore();
 const reply=store.appendIncoming('group:1',{mid:954554900,senderId:'friend',text:'[引用 群友：[image]]看看这张',media:[]});
 store.appendIncoming('group:1',{mid:1553492030,senderId:'friend',text:'[图片]',media:[{kind:'image',url:'https://image.example/test.png'}]});
 store.updateByMid('group:1',1553492030,{visualSummary:'蓝色背景，红色圆形，CHECK 827'});
 let reads=0;
 const ctx={chatKey:'group:1',store,onebot:{getMsg:async()=>{reads++;return {group_id:1,message:[{type:'reply',data:{id:'1553492030'}},{type:'text',data:{text:'看看这张'}}]};}}};
 const result=await executeTool(buildToolDefs(),ctx,'get_message_images',{messageId:954554900});
 assert.match(result.content,/827/,'image tool must retrieve quoted image instead of claiming no image');
 assert.equal(JSON.parse(result.content).messageId,1553492030);
 assert.equal(reads,1);
 const plain=store.appendIncoming('group:1',{mid:3,senderId:'friend',text:'能看图了？',media:[]});
 assert.equal((await replyImageSource(ctx,plain)).entry.mid,3);assert.equal(reads,1,'plain text must not trigger protocol lookup');
 assert.match((await replyImageSource({...ctx,isVisible:()=>false},reply)).error,/可见历史/);
 assert.match((await replyImageSource({...ctx,store:{findByMid:()=>null}},reply)).error,/#1553492030/);
 const persisted={...reply,reply:{messageId:1553492030}};
 const n=reads;assert.equal((await replyImageSource(ctx,persisted)).entry.mid,1553492030);assert.equal(reads,n,'persisted reference avoids protocol query');
 assert.match((await replyImageSource({...ctx,onebot:{getMsg:async()=>({group_id:2})}},reply)).error,/不匹配/);
 console.log('PASS: reported quoted-image tool path, correct source ID, plain text, missing/blocked source and chat isolation');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
