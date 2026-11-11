import { createHmac, timingSafeEqual } from 'node:crypto';
const valid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function createPageReviewBridge({ getIdentity, readConfig, loginOrigin, layout, fetcher = fetch }) {
  return async function pageReview(req, res, next) {
    if (req.path !== '/page-review/authorize') return next();
    try {
      const config = readConfig();
      if (!config || new URL(config.apiOrigin).origin !== config.apiOrigin || !config.apiOrigin.startsWith('https://') || typeof config.key !== 'string' || config.key.length < 40) return res.status(503).send('Page Review登录暂未配置');
      const identity = await getIdentity(req);
      if (!identity) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
      let requestId = String(req.query.request_id || ''), csrf = '';
      if (req.method === 'POST') {
        if (req.headers.origin !== loginOrigin || req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') return res.status(403).send('请从登录页面继续');
        let body = ''; for await (const chunk of req) { body += chunk.toString(); if (Buffer.byteLength(body) > 2048) return res.status(413).send('请求过大'); }
        const form = new URLSearchParams(body); requestId = form.get('request_id'); csrf = form.get('csrf');
      }
      if (!valid(requestId)) return res.status(400).send('请从Page Review插件重新开始登录');
      const signature = value => createHmac('sha256', config.key).update(value).digest('base64url');
      const expected = signature('consent\0' + requestId + '\0' + identity.session.id);
      if (req.method === 'GET') return res.send(layout('登录网页评注', `<div class="eyebrow">PAGE REVIEW</div><h1>保存你的网页关注点。</h1><p>以 ${esc(identity.user.name)} 的身份登录网页评注。新标注会保存到你的私人空间，之后可以单独授权AI读取。</p><form id="page-review-consent" method="post" action="/page-review/authorize"><input type="hidden" name="request_id" value="${requestId}"><input type="hidden" name="csrf" value="${expected}"><button type="submit">登录并开启同步</button></form><p>已有的本机标注保留，上传由你单独选择。</p><p id="page-review-error" role="alert"></p>`, `document.querySelector("#page-review-consent").addEventListener("submit",async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector("button");button.disabled=true;try{const r=await fetch("/page-review/authorize",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams(new FormData(form)).toString()});const value=await r.json();if(!r.ok)throw Error("登录未完成，请从插件重新开始。");location.assign(value.callbackUrl);}catch{document.querySelector("#page-review-error").textContent="登录暂时未完成，请从插件重新开始。";button.disabled=false;}});`));
      if (req.method !== 'POST') return res.status(405).send('请求方式无效');
      if (!valid(csrf) || !timingSafeEqual(Buffer.from(csrf), Buffer.from(expected))) return res.status(403).send('登录页面已失效，请重新开始');
      const payload = JSON.stringify({ iss: loginOrigin, aud: config.apiOrigin, requestId, sub: identity.user.id, name: identity.user.name, sessionExpiresAt: new Date(identity.session.expiresAt).toISOString(), exp: Date.now() + 60_000 });
      const response = await fetcher(config.apiOrigin + '/auth/approve', { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payload, signature: signature(payload) }) });
      const result = await response.json();
      if (!response.ok) return res.status(response.status === 409 ? 409 : 502).send('登录未完成，请从插件重新开始。');
      const callback = new URL(result.callbackUrl);
      if (callback.protocol !== 'https:' || !/^[a-p]{32}\.chromiumapp\.org$/.test(callback.host) || callback.pathname !== '/page-review' || callback.hash || !valid(callback.searchParams.get('code')) || !valid(callback.searchParams.get('state'))) return res.status(502).send('登录回跳校验失败');
      return res.json({callbackUrl:callback.href});
    } catch { return res.status(503).send('登录暂时不可用，你的本机标注仍保留。'); }
  };
}
