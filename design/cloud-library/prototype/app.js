'use strict';
const paths={cloud:'<path d="M6 18a4 4 0 0 1-1-8 7 7 0 0 1 13-1 4.5 4.5 0 0 1 0 9Z"/>',search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',close:'<path d="m6 6 12 12M18 6 6 18"/>',like:'<path d="M7 10v11H3V10h4Zm0 0 5-7c1-1 3 0 3 2l-1 5h5a2 2 0 0 1 2 2l-2 7a3 3 0 0 1-3 2H7"/>',dislike:'<path d="M7 14V3H3v11h4Zm0 0 5 7c1 1 3 0 3-2l-1-5h5a2 2 0 0 0 2-2l-2-7a3 3 0 0 0-3-2H7"/>',check:'<path d="m5 12 4 4L19 6"/>',link:'<path d="m10 13 4-4m-6 7-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 4 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>'};
const icon=name=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+(paths[name]||paths.cloud)+'</svg>';
const esc=value=>String(value??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const storageKey='page-review-cloud-design-v3',connections=document.getElementById('connections'),sheet=document.getElementById('sheet');
let fixture,state={query:'',filter:'all',online:true,connection:false,revoked:false,lastRead:false,mode:'skill',syncedLocal:false},toastTimer;
try{Object.assign(state,JSON.parse(localStorage.getItem(storageKey)||'{}'));}catch{}
const persist=()=>localStorage.setItem(storageKey,JSON.stringify(state));
const feedback=n=>n.feedback?'<span class="feedback '+(n.feedback==='negative'?'negative':'')+'" role="img" aria-label="'+(n.feedback==='positive'?'点赞':'点踩')+'">'+icon(n.feedback==='positive'?'like':'dislike')+'</span>':'';
const isCloud=n=>n.status==='synced'||state.syncedLocal;
const groups=()=>fixture.pages.map(p=>({...p,notes:fixture.annotations.filter(n=>n.pageId===p.id)}));
function toast(text){clearTimeout(toastTimer);const el=document.getElementById('toast');el.textContent=text;el.classList.add('visible');toastTimer=setTimeout(()=>el.classList.remove('visible'),2500);}
function render(){
 const pending=fixture.annotations.filter(n=>!isCloud(n)).length,cloud=fixture.annotations.length-pending;
 document.getElementById('connection-button').innerHTML=icon('link')+(state.connection?'AI 已连接':'连接 AI');
 document.querySelector('[data-action="network"]').textContent=state.online?'模拟离线':'恢复在线';
 document.getElementById('sync-status').className='cloud-status'+(pending||!state.online?' pending':'');
 document.getElementById('sync-status').innerHTML='<span class="status-dot"></span>'+(state.online?(cloud+' 条已保存到云端'+(pending?' · '+pending+' 条待同步':'')):'当前离线 · 已保存资料仍可浏览')+(pending?'<button class="text-button" data-action="sync" '+(!state.online?'disabled':'')+'>同步待上传资料</button>':'');
 const filters=[['all','全部'],['positive','点赞'],['negative','点踩'],['pending','待同步']];
 document.getElementById('filters').innerHTML=filters.map(([key,label])=>'<button data-action="filter" data-filter="'+key+'" class="'+(state.filter===key?'active':'')+'">'+label+(key==='pending'&&pending?'<span class="tiny-count">'+pending+'</span>':'')+'</button>').join('');
 const query=state.query.trim().toLowerCase(),visible=groups().filter(p=>(!query||[p.title,p.url,...p.notes.map(n=>n.comment)].join(' ').toLowerCase().includes(query))&&(state.filter==='all'||p.notes.some(n=>state.filter==='pending'?!isCloud(n):n.feedback===state.filter)));
 document.getElementById('cards').innerHTML=visible.map(p=>{const pending=p.notes.filter(n=>!isCloud(n)).length;return '<article class="page-card"><div class="card-art"><img src="'+p.art+'" alt="'+esc(p.name)+'公开示意画面"></div><div class="card-body" role="button" tabindex="0" data-action="detail" data-page="'+p.id+'" aria-label="查看 '+esc(p.name)+' 评论"><div class="card-source"><span class="favicon '+p.id+'">'+p.name[0].toLowerCase()+'</span>'+esc(new URL(p.url).hostname)+'</div><h2>'+esc(p.title)+'</h2><p class="card-excerpt">'+feedback(p.notes[0])+esc(p.notes[0].comment)+'</p><div class="card-foot"><span>'+p.notes.length+' 条评论</span><span class="'+(pending?'pending-label':'')+'">'+(pending?pending+' 条待同步':icon('cloud')+' 已同步')+'</span></div></div></article>';}).join('')||'<div class="empty-library">没有匹配的网页或评论</div>';
 document.getElementById('search-icon').innerHTML=icon('search');persist();
}
function cloudNote(n,withImage){const p=fixture.pages.find(p=>p.id===n.pageId);return '<article class="cloud-note"><div class="cloud-note-head">'+feedback(n)+'<span>'+esc(n.id)+'</span><span class="status-label '+(!isCloud(n)?'warning':'')+'">'+(isCloud(n)?'云端已保存':'仅本机 · 待同步')+'</span></div>'+(n.comment?'<p>'+esc(n.comment)+'</p>':'')+(withImage?'<img src="'+p.art+'" alt="公开合成的记录时示意画面"><div class="drawing-caption">记录时画面 · 示意</div>':'')+'</article>';}
function openDetail(id){const p=groups().find(p=>p.id===id);sheet.className='drawer';sheet.innerHTML='<header class="drawer-head"><div><h2>'+esc(p.name)+'</h2><p>'+p.notes.length+' 条评论 · '+esc(new URL(p.url).hostname)+'</p></div><button class="icon-btn" data-action="close-sheet" aria-label="关闭详情">'+icon('close')+'</button></header><div class="drawer-content"><img class="snapshot-thumb" src="'+p.art+'" alt="公开页面示意画面"><div class="drawing-caption">示例页面与画面</div><a class="source-link" href="'+p.url+'" target="_blank" rel="noreferrer">'+esc(p.url)+'</a><div class="record-list">'+p.notes.map(n=>cloudNote(n,false)).join('')+'</div></div><footer class="drawer-footer"><button class="btn" data-action="connections">'+icon('link')+'AI 访问设置</button></footer>';if(!sheet.open)sheet.showModal();}
function renderConnections(){
 const connected=state.connection;
 connections.innerHTML='<div class="modal-head"><h2>连接 AI</h2><button class="icon-btn" data-action="close-connections" aria-label="关闭连接设置">'+icon('close')+'</button></div><p class="access-info">连接一次，Agent 便能按需查找和读取你的资料。</p><div class="access-summary"><div class="access-row"><span>可读取</span><strong>来源、评论、赞踩与原始画面</strong></div><div class="access-row"><span>访问范围</span><strong>我的私人资料库</strong></div><div class="access-row"><span>操作权限</span><strong>只读</strong></div></div><div class="access-tabs" role="group" aria-label="接入方式"><button data-action="access-mode" data-mode="skill" class="'+(state.mode==='skill'?'active':'')+'">Skill</button><button data-action="access-mode" data-mode="api" class="'+(state.mode==='api'?'active':'')+'">API</button></div>'+(state.mode==='skill'?'<p class="access-info">Agent 通过 Skill 检索资料、读评论和查看画面。你直接在 Agent 中描述任务，无需逐次传递材料。</p>':'<p class="access-info">使用同一个只读接口检索记录、获取上下文和读取图片。接口约定见下方示例。</p><pre class="access-config">GET /v1/annotations?q=导航\nGET /v1/annotations/:id/context\nGET /v1/assets/:id</pre>')+(connected?'<div class="connection-bar"><div class="connection-name">'+icon('link')+'<span>我的 Agent</span><span class="readonly-badge">● 只读连接</span></div><p>最近读取：'+(state.lastRead?'刚刚（演示）':'尚未读取')+'</p></div><pre class="access-config">PAGE_REVIEW_API_URL=https://your-cloud.example.invalid\nPAGE_REVIEW_TOKEN=DEMO_NOT_A_CREDENTIAL</pre><p class="access-help">这是接入配置示例，只在首次连接时配置；资料由 Agent 按需读取。演示地址与凭证不可用于真实服务。</p><div class="access-actions"><button class="btn" data-action="copy-config">复制配置示例</button><button class="btn primary" data-action="agent-demo">查看读取演示</button></div><div class="access-actions"><button class="danger-link" data-action="revoke">撤销此连接</button></div>':'<p class="access-help">首次配置 Skill 或 API 连接，之后不必下载或复制网页资料。</p><div class="access-actions"><button class="btn primary" data-action="create-connection">创建只读连接（演示）</button></div>');
}
function openConnections(){if(sheet.open)sheet.close();renderConnections();if(!connections.open)connections.showModal();}
function openAgent(){if(connections.open)connections.close();sheet.className='drawer agent-drawer';sheet.innerHTML='<header class="drawer-head"><div><h2>Agent 读取演示</h2><p>公开示例数据 · 不调用真实模型</p></div><button class="icon-btn" data-action="close-sheet" aria-label="关闭读取演示">'+icon('close')+'</button></header><div class="drawer-content"><div class="agent-demo-label">模拟 Agent 在任务中自行查找资料</div><label class="field-label" for="agent-query">检索什么资料</label><div class="agent-query"><input id="agent-query" aria-label="Agent检索词" value="导航"><button class="btn primary" data-action="agent-search">检索</button></div><div id="agent-result">'+(!state.connection?'<div class="empty-agent">先为 Agent 创建一个只读连接，之后它才能读取这份资料库。</div><button class="btn" data-action="connections">设置 AI 访问</button>':'<div class="empty-agent">点“检索”，查看 Agent 能拿到的原始评论与画面。</div>')+'</div></div>';if(!sheet.open)sheet.showModal();}
async function readAsAgent(){
 const result=document.getElementById('agent-result');
 if(!state.connection){result.innerHTML='<div class="agent-error">401 · '+(state.revoked?'连接已撤销，Agent 无法继续读取。':'尚未授权只读连接。')+'</div>';return;}
 const data=await fetch('fixtures.json',{cache:'no-store'}).then(r=>r.json()),q=document.getElementById('agent-query').value.trim().toLowerCase();
 const rows=data.annotations.filter(n=>isCloud(n)&&(!q||[n.comment,data.pages.find(p=>p.id===n.pageId).title].join(' ').toLowerCase().includes(q)));
 state.lastRead=true;persist();
 result.innerHTML='<div class="agent-step">检索已同步资料<span>'+rows.length+' 条</span></div><div class="agent-step">读取原话与明确赞踩<span>'+rows.length+' 条</span></div><div class="agent-step">读取对应画面<span>'+rows.length+' 张示意图</span></div>'+(!state.syncedLocal?'<p class="access-help">待同步的本机记录不包含在读取结果中。</p>':'')+'<section class="agent-evidence"><h3>交给 Agent 的原始资料</h3>'+rows.map(n=>cloudNote(n,true)).join('')+(rows.length?'':'<div class="empty-agent">没有匹配的已同步记录。</div>')+'</section>';
}
document.addEventListener('input',e=>{if(e.target.id==='search'){state.query=e.target.value;render();}});
document.addEventListener('keydown',e=>{const target=e.target.closest('[data-action="detail"]');if(target&&(e.key==='Enter'||e.key===' ')){e.preventDefault();openDetail(target.dataset.page);}});
document.addEventListener('click',async e=>{const b=e.target.closest('[data-action]');if(!b)return;const action=b.dataset.action;
 if(action==='filter'){state.filter=b.dataset.filter;render();}
 if(action==='detail')openDetail(b.dataset.page);
 if(action==='close-sheet')sheet.close();
 if(action==='close-connections')connections.close();
 if(action==='connections')openConnections();
 if(action==='access-mode'){state.mode=b.dataset.mode;renderConnections();persist();}
 if(action==='create-connection'){state.connection=true;state.revoked=false;renderConnections();render();toast('只读连接已创建（演示）');}
 if(action==='copy-config'){try{await navigator.clipboard.writeText('PAGE_REVIEW_API_URL=https://your-cloud.example.invalid\nPAGE_REVIEW_TOKEN=DEMO_NOT_A_CREDENTIAL');toast('已复制示例配置；不是网页资料');}catch{toast('请从示例框查看配置');}}
 if(action==='revoke'){state.connection=false;state.revoked=true;renderConnections();render();toast('连接已撤销（演示）');}
 if(action==='network'){state.online=!state.online;render();}
 if(action==='sync'){if(!state.online)return;state.syncedLocal=true;render();toast('待上传记录已同步（演示）');}
 if(action==='agent-demo')openAgent();
 if(action==='agent-search')await readAsAgent();
});
fetch('fixtures.json',{cache:'no-store'}).then(r=>r.json()).then(data=>{fixture=data;document.getElementById('search').value=state.query;render();}).catch(()=>{document.getElementById('cards').innerHTML='<div class="empty-library">示例资料加载失败</div>';});
