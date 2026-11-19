const {test}=require('node:test'), assert=require('node:assert/strict'), crypto=require('node:crypto'), vm=require('node:vm');
const {setup}=require('./helpers/cloud.cjs');
const issuer='https://login.example',api='https://test.invalid',key='only-synthetic-bridge-key-'.repeat(3);
const random=()=>crypto.randomBytes(32).toString('base64url');
const pkce=v=>crypto.createHash('sha256').update(v).digest('base64url');
async function fixture() {
 const t=await setup();Object.assign(t.env,{API_ORIGIN:api,LOGIN_ORIGIN:issuer,LOGIN_BRIDGE_KEY:key});
 const {createPageReviewBridge}=await import('../integrations/better-auth/page-review.mjs');
 let identity={user:{id:'alice',name:'测试'},session:{id:'session-a',expiresAt:new Date(Date.now()+3600000)}};
 let approvals=0;
 const bridge=createPageReviewBridge({getIdentity:async()=>identity,readConfig:()=>({apiOrigin:api,key}),loginOrigin:issuer,
 layout:(title,content,script)=>content+'<script>'+script+'</script>',fetcher:async(url,options={})=>{
   if(url.endsWith('/auth/approve'))approvals++;
   return (await import('../cloud/worker.mjs')).default.fetch(new Request(url,options),t.env);
 }});
 async function route(id,method='GET',body='',origin=issuer){const req={path:'/page-review/authorize',originalUrl:'/page-review/authorize?request_id='+id,
 query:{request_id:id},method,headers:{origin,'content-type':'application/x-www-form-urlencoded'},async *[Symbol.asyncIterator](){yield Buffer.from(body);}};
 const res={code:200,status(c){this.code=c;return this;},send(v){this.body=v;return this;},json(v){this.body=v;return this;},redirect(v){this.code=302;this.location=v;return this;}};
 await bridge(req,res,()=>{});return res;}
 const verifier=random(),proof=random(),state=random();
 const start=await t.request('/auth/extension/start',{method:'POST',data:{callback:'https://'+'a'.repeat(32)+'.chromiumapp.org/page-review',state,challenge:pkce(verifier),intentChallenge:pkce(proof)}});
 assert.equal(start.status,200);const {requestId}=await start.json();
 return {...t,requestId,verifier,proof,state,route,identity:v=>identity=v,approvals:()=>approvals};
}
test('插件主动登录未登录时去身份页，已登录自动接续无确认按钮；PKCE一次交换且原空间稳定',async()=>{
 const t=await fixture();const saved={user:{id:'alice',name:'测试'},session:{id:'session-a',expiresAt:new Date(Date.now()+3600000)}};
 t.identity(null);const unauth=await t.route(t.requestId);assert.equal(unauth.code,302);assert.match(unauth.location,/login\?next=/);
 t.identity(saved);const page=await t.route(t.requestId);assert(!page.body.includes('<button'));assert(!page.body.includes('登录并开启同步'));assert.equal(t.approvals(),0);
 let token,code;
 const ctx=vm.createContext({URLSearchParams,document:{querySelector:()=>({textContent:''})},chrome:{runtime:{sendMessage:async(id,message)=>{
   assert.equal(id,'a'.repeat(32));assert.equal(message.requestId,t.requestId);
   if(message.type==='PAGE_REVIEW_LOGIN_PROOF')return {proof:t.proof};
   const callback=new URL(message.callbackUrl);assert.equal(callback.searchParams.get('state'),t.state);code=callback.searchParams.get('code');
   const response=await t.request('/auth/exchange',{method:'POST',data:{code,verifier:t.verifier}});assert.equal(response.status,200);token=(await response.json()).token;return {ok:true};
 }}},fetch:async(url,options)=>{assert.equal(url,'/page-review/authorize');const res=await t.route(t.requestId,'POST',options.body);return new Response(JSON.stringify(res.body),{status:res.code});}});
 await vm.runInContext(page.body.match(/<script>([\s\S]*)<\/script>/)[1],ctx);
 assert(token);assert.equal(t.approvals(),1);
 assert.equal((await t.request('/auth/exchange',{method:'POST',data:{code,verifier:t.verifier}})).status,401);
 assert.equal((await t.request('/v1/me',{token})).status,200);
});
test('陌生授权链接拿不到发起插件的证明；错误证明、跨站POST与账号切换不签发writer',async()=>{
 const t=await fixture(), page=await t.route(t.requestId);
 const fields=JSON.parse(page.body.match(/new URLSearchParams\(\{\.\.\.(\{[^\n]+?\}),proof:/)[1]);
 const post=(proof,origin)=>t.route(t.requestId,'POST',new URLSearchParams({...fields,proof}).toString(),origin);
 assert.equal((await post('x'.repeat(43))).code,502);
 assert.equal((await post(t.proof,'https://evil.example')).code,403);
 t.identity({user:{id:'bob',name:'乙'},session:{id:'session-b',expiresAt:new Date(Date.now()+3600000)}});
 assert.equal((await post(t.proof)).code,403);
 assert.equal(t.sql.prepare('SELECT COUNT(*) n FROM users').get().n,0);
});
test('期待账号和过期请求在API端检查，不能换成另一账号或复用旧请求',async()=>{
 const t=await fixture();t.sql.prepare('UPDATE login_requests SET expected_workspace=? WHERE id=?').run('w-'+'0'.repeat(40),t.requestId);
 const page=await t.route(t.requestId),fields=JSON.parse(page.body.match(/new URLSearchParams\(\{\.\.\.(\{[^\n]+?\}),proof:/)[1]);
 assert.equal((await t.route(t.requestId,'POST',new URLSearchParams({...fields,proof:t.proof}).toString())).code,409);
 t.sql.prepare('UPDATE login_requests SET expires_at=0 WHERE id=?').run(t.requestId);
 assert.equal((await t.route(t.requestId)).code,503);
 assert.equal(t.sql.prepare('SELECT COUNT(*) n FROM users').get().n,0);
});
