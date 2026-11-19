const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const {png}=require('./helpers/cloud.cjs');
async function fixture(fail=false){let active=0,max=0,committed=false,failed=false,uploads=[];
 const picture=i=>{const p=Buffer.from(png);p[p.length-1]=i;return 'data:image/png;base64,'+p.toString('base64');};
 const image={viewport:picture(0),crop:picture(0),frames:[1,2,3].map(i=>({data:picture(i)}))};
 let ready;const started=new Promise(r=>ready=r);
 let release;const gate=new Promise(r=>release=r),rows=[{id:'concurrent-note',kind:'upsert',workspaceId:'w',note:{hasImage:true},localRevision:1}];
 const ctx=vm.createContext({crypto,AbortSignal,Uint8Array,TextEncoder,DataView,atob,btoa});vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../extension/cloud.js'),'utf8'),ctx);
 const api=ctx.PageReviewCloudFactory({apiOrigin:'https://cloud.example',storage:{get:async k=>({[k]:k==='cloudConnection'?{apiUrl:'https://cloud.example',workspaceId:'w',token:'test'}:null}),set:async()=>{}},db:{pending:async()=>rows,asset:async()=>image,acknowledge:async()=>{rows.length=0;committed=true;},markFailure:async()=>{failed=true;assert.equal(active,0);}},fetcher:async(url)=>{
 if(!url.includes('/uploads/')){assert.equal(active,0);return new Response('{"revision":1}');}
 active++;max=Math.max(max,active);uploads.push(url);if(active===3)ready();await gate;active--;if(fail)throw Error('offline');return new Response('{}');
 }});
 return {api,release,started,state:()=>({active,max,committed,failed,uploads,rows})};}
test('内容相同角色只上传一次，并发最多三份；全部结束才提交评注',async()=>{const t=await fixture(),work=t.api.sync();await t.started;assert.equal(t.state().active,3);t.release();await work;const s=t.state();assert.equal(s.max,3);assert.equal(s.uploads.length,4);assert(s.committed);assert(!s.failed);});
test('并发上传失败等其他在途上传结束后保留待传，不提交部分引用也不自动重试',async()=>{const t=await fixture(true),work=t.api.sync();await t.started;t.release();await work;const s=t.state();assert(s.failed);assert(!s.committed);assert.equal(s.active,0);assert.equal(s.rows.length,1);assert.equal(s.uploads.length,3);});
