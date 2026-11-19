const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), crypto = require('node:crypto');
function fixture(shared = {}) {
  const data = shared.data || {}, external = [], removed = [], actions = [], timers = [];
  let completeCount = 0;
  const chrome = {
    storage: { session: { get: async key => ({[key]: data[key]}), set: async v => Object.assign(data,v), remove: async k => delete data[k] } },
    runtime: { onMessageExternal: { addListener: f => external.push(f) } },
    windows: { update: async (...args) => actions.push(['focus', ...args]) },
    tabs: { create: async v => {actions.push(['create',v]);return {id: 12};},
      update: async (...v) => {actions.push(['update',...v]);return {id:v[0]};},
      get: async id => ({id,windowId:9}), remove: async id => actions.push(['remove',id]),
      sendMessage: async (...v) => actions.push(['notify',...v]), onRemoved: {addListener:f=>removed.push(f)} },
  };
  const context = vm.createContext({URL,console,clearTimeout:()=>{},setTimeout:f=>{timers.push(f);return timers.length;}});
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../extension/login-tabs.js'),'utf8'),context);
  const api = context.PageReviewTabLoginFactory({chrome,loginOrigin:'https://login.example',complete:async(c,url)=>{completeCount++;assert.equal(c.state,'s');assert.equal(url,'callback');return {configured:true};}});
  const requestId=crypto.randomBytes(32).toString('base64url');
  const started = {requestId,authorizeUrl:'https://login.example/page-review/authorize?request_id='+requestId,proof:'p'.repeat(43)};
  const sender = () => ({url:started.authorizeUrl,tab:{id:12},frameId:0});
  const send = (message, s=sender()) => new Promise(resolve=>external[0]({requestId,...message},s,resolve));
  const launch = () => api.launch(async()=>started,{state:'s',resume:'copy'},{id:7,windowId:9});
  return {api,data,actions,timers,removed,send,launch,sender,started,count:()=>completeCount};
}
test('普通标签页登录绑定发起窗口、请求与精确标签；重复点击不创建新窗口',async()=>{
 const t=fixture();const login=t.launch();await new Promise(setImmediate);
 assert.equal(t.actions.filter(a=>a[0]==='create').length,1);
 assert.equal(t.actions.find(a=>a[0]==='create')[1].windowId,9);
 await assert.rejects(t.launch(),/登录正在进行/);
 for(const sender of [{...t.sender(),tab:{id:13}},{...t.sender(),frameId:1},{...t.sender(),url:'https://evil.example/page-review/authorize'}])
   assert((await t.send({type:'PAGE_REVIEW_LOGIN_PROOF'},sender)).error);
 assert((await t.send({type:'PAGE_REVIEW_LOGIN_PROOF',requestId:'x'})).error);
 assert.equal((await t.send({type:'PAGE_REVIEW_LOGIN_PROOF'})).proof,t.started.proof);
 assert((await t.send({type:'PAGE_REVIEW_LOGIN_COMPLETE',callbackUrl:'callback'})).ok);
 assert((await login).configured);assert.equal(t.count(),1);assert(!t.data.pageReviewLogin);
 assert(t.actions.some(a=>a[0]==='update'&&a[1]===7));
 assert(t.actions.some(a=>a[0]==='remove'&&a[1]===12));
 assert((await t.send({type:'PAGE_REVIEW_LOGIN_COMPLETE',callbackUrl:'callback'})).error);
});
test('关闭或超时取消只清理本次登录，保留来源页；一次超时不查询状态',async()=>{
 for(const mode of ['close','timeout']){const t=fixture();const login=t.launch();const rejected=assert.rejects(login,/取消|过期/);await new Promise(setImmediate);
 if(mode==='close')t.removed[0](12);else await t.timers[0]();await rejected;
 assert.equal(t.count(),0);assert(!t.actions.some(a=>a[0]==='remove'&&a[1]===7));assert(!t.data.pageReviewLogin);}
});
test('worker重启后从session恢复一次性请求，完成后向原页发送接续事件',async()=>{
 const old=fixture();old.launch();await new Promise(setImmediate);
 const current=fixture({data:old.data});Object.assign(current.started,old.started);
 assert((await current.send({type:'PAGE_REVIEW_LOGIN_COMPLETE',callbackUrl:'callback',requestId:old.started.requestId},old.sender())).ok);
 assert(current.actions.some(a=>a[0]==='notify'&&a[1]===7&&a[2].resume==='copy'));
 assert(!current.data.pageReviewLogin);
});
