import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
const valid = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const loopback = (value) => {
  try {
    const u = new URL(value);
    return (
      u.protocol === "http:" &&
      u.hostname === "127.0.0.1" &&
      Number(u.port) >= 1024 &&
      Number(u.port) <= 65535 &&
      u.pathname === "/callback" &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash
    );
  } catch {
    return false;
  }
};
function autoForm(res, action, fields, loginOrigin) {
  const nonce = randomBytes(18).toString("base64url"),
    destination = new URL(action, loginOrigin);
  // The cross-site return is only a transport page: it cannot approve anything.
  res.set?.({
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; form-action ${destination.origin}; frame-ancestors 'none'; base-uri 'none'`,
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "origin",
  });
  return res.send(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>连接终端 · Page Review</title><body><p>正在连接当前终端…</p><form method="post" action="${esc(action)}">${Object.entries(
      fields,
    )
      .map(
        ([name, value]) =>
          `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`,
      )
      .join(
        "",
      )}</form><script nonce="${nonce}">${destination.origin === loginOrigin ? `const f=document.forms[0];fetch(f.action,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams(new FormData(f)).toString()}).then(async r=>{if(!r.ok)throw Error(await r.text());return r.json()}).then(v=>location.replace(v.callbackUrl)).catch(e=>document.querySelector("p").textContent=e.message)` : "document.forms[0].submit()"}</script></body></html>`,
  );
}
export function createPageReviewBridge({
  getIdentity,
  readConfig,
  loginOrigin,
  layout,
  fetcher = fetch,
}) {
  return async function pageReview(req, res, next) {
    if (
      !["/page-review/authorize", "/page-review/terminal-return"].includes(
        req.path,
      )
    )
      return next();
    try {
      const config = readConfig();
      if (
        !config ||
        new URL(config.apiOrigin).origin !== config.apiOrigin ||
        !config.apiOrigin.startsWith("https://") ||
        typeof config.key !== "string" ||
        config.key.length < 40
      )
        return res.status(503).send("Page Review登录暂未配置");
      const signature = (value) =>
        createHmac("sha256", config.key).update(value).digest("base64url");
      let requestId = String(req.query.request_id || ""),
        csrf = "",
        relay = "",
        proof = "";
      if (req.method === "POST") {
        if (
          req.headers["content-type"]?.split(";")[0] !==
          "application/x-www-form-urlencoded"
        )
          return res.status(403).send("连接请求格式无效");
        let body = "";
        for await (const chunk of req) {
          body += chunk.toString();
          if (Buffer.byteLength(body) > 8192)
            return res.status(413).send("请求过大");
        }
        const form = new URLSearchParams(body);
        requestId = form.get("request_id");
        csrf = form.get("csrf");
        relay = form.get("relay");
        proof = form.get("proof");
      }
      const unpack = (value) => {
        if (
          typeof value !== "string" ||
          value.length > 6000 ||
          !/^[\w-]+\.[\w-]{43}$/.test(value)
        )
          return null;
        const [encoded, mac] = value.split(".");
        if (
          !timingSafeEqual(
            Buffer.from(mac),
            Buffer.from(signature("terminal-relay\0" + encoded)),
          )
        )
          return null;
        const data = JSON.parse(Buffer.from(encoded, "base64url"));
        return data.requestId === requestId &&
          data.expires > Date.now() &&
          data.expires <= Date.now() + 120000
          ? data
          : null;
      };
      // Cross-site POST carries no Lax session cookie. It only installs a same-origin
      // continuation document; the following same-origin POST checks the live session.
      if (req.path === "/page-review/terminal-return") {
        if (req.method !== "POST")
          return res.status(405).send("请从当前终端开始连接");
        const data = unpack(relay);
        if (
          !data ||
          !valid(proof) ||
          !loopback(data.callback) ||
          req.headers.origin !== new URL(data.callback).origin
        )
          return res.status(403).send("未验证当前终端，连接已停止");
        return autoForm(
          res,
          "/page-review/authorize",
          { request_id: requestId, csrf: data.csrf, relay, proof },
          loginOrigin,
        );
      }
      if (req.method === "POST" && req.headers.origin !== loginOrigin)
        return res.status(403).send("请从登录页面继续");
      const identity = await getIdentity(req);
      if (!identity) {
        if (req.method !== "GET")
          return res.status(401).send("登录已失效，请重新连接终端");
        return res.redirect(
          "/login?next=" + encodeURIComponent(req.originalUrl),
        );
      }
      if (!valid(requestId))
        return res.status(400).send("请从Page Review插件重新开始登录");
      const expected = signature(
        "consent\0" + requestId + "\0" + identity.session.id,
      );
      if (req.method === "GET") {
        const info = await fetcher(
          config.apiOrigin +
            "/auth/request?" +
            new URLSearchParams({ request_id: requestId }),
          { redirect: "manual", signal: AbortSignal.timeout(20000) },
        );
        const details = await info.json();
        if (!info.ok || !["reader", "writer"].includes(details.access))
          return res.status(503).send("登录请求暂不可用，请重新开始");
        const reader = details.access === "reader";
        if (
          details.terminalIntent === true &&
          reader &&
          loopback(details.callback)
        ) {
          const data = {
            requestId,
            callback: details.callback,
            sessionId: identity.session.id,
            subject: identity.user.id,
            csrf: expected,
            expires: Date.now() + 60000,
          };
          const encoded = Buffer.from(JSON.stringify(data)).toString(
            "base64url",
          );
          return autoForm(
            res,
            new URL("/connect", details.callback).href,
            {
              request_id: requestId,
              relay: encoded + "." + signature("terminal-relay\0" + encoded),
            },
            loginOrigin,
          );
        }
        if (!reader && details.extensionIntent === true &&
            /^https:\/\/([a-p]{32})\.chromiumapp\.org\/page-review$/.test(details.callback || "")) {
          const extensionId = new URL(details.callback).hostname.split(".")[0];
          const data = { requestId, sessionId: identity.session.id, subject: identity.user.id,
            kind: "extension", csrf: expected, expires: Date.now() + 60000 };
          const encoded = Buffer.from(JSON.stringify(data)).toString("base64url");
          const fields = { request_id: requestId, csrf: expected,
            relay: encoded + "." + signature("terminal-relay\0" + encoded) };
          return res.send(layout("正在登录网页评注",
            '<div class="eyebrow">PAGE REVIEW</div><h1>正在返回网页…</h1><p id="page-review-status" role="status">身份已验证，正在接续同步。</p>',
            `(async()=>{try{const extensionId=${JSON.stringify(extensionId)},requestId=${JSON.stringify(requestId)};
            if(!globalThis.chrome?.runtime?.sendMessage)throw Error();
            const proof=await chrome.runtime.sendMessage(extensionId,{type:"PAGE_REVIEW_LOGIN_PROOF",requestId});
            if(!proof?.proof)throw Error();
            const r=await fetch("/page-review/authorize",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({...${JSON.stringify(fields)},proof:proof.proof}).toString()});
            if(!r.ok)throw Error();const value=await r.json();
            const done=await chrome.runtime.sendMessage(extensionId,{type:"PAGE_REVIEW_LOGIN_COMPLETE",requestId,callbackUrl:value.callbackUrl});
            if(!done?.ok)throw Error();document.querySelector("#page-review-status").textContent="已登录，可以返回原网页。";
            }catch{document.querySelector("#page-review-status").textContent="登录未完成，请返回插件重试；本机评注仍保留。";}})();`));
        }
        return res.send(
          layout(
            reader ? "授权终端" : "登录网页评注",
            `<div class="eyebrow">PAGE REVIEW</div><h1>${reader ? "授权终端读取评注" : "登录网页评注"}</h1><p>${reader ? "终端只能读取你已同步的评注和附件。" : "新标注会保存到你的私人空间。"} ${esc(identity.user.name)}</p><form id="page-review-consent" method="post" action="/page-review/authorize"><input type="hidden" name="request_id" value="${requestId}"><input type="hidden" name="csrf" value="${expected}"><button type="submit">${reader ? "授权只读访问" : "登录并开启同步"}</button></form><p id="page-review-error" role="alert"></p>`,
            `document.querySelector("#page-review-consent").addEventListener("submit",async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector("button");button.disabled=true;try{const r=await fetch("/page-review/authorize",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams(new FormData(form)).toString()});const value=await r.json();if(!r.ok)throw Error("登录未完成，请从插件重新开始。");location.assign(value.callbackUrl);}catch{document.querySelector("#page-review-error").textContent="登录暂时未完成，请从插件重新开始。";button.disabled=false;}});`,
          ),
        );
      }
      if (req.method !== "POST") return res.status(405).send("请求方式无效");
      if (
        !valid(csrf) ||
        !timingSafeEqual(Buffer.from(csrf), Buffer.from(expected))
      )
        return res.status(403).send("登录页面已失效，请重新开始");
      let data;
      if (relay || proof) {
        data = unpack(relay);
        if (
          !data ||
          data.sessionId !== identity.session.id ||
          data.subject !== identity.user.id ||
          !valid(proof)
        )
          return res
            .status(403)
            .send("浏览器账号已变化或连接已过期，请重新连接");
      }
      const payload = JSON.stringify({
        iss: loginOrigin,
        aud: config.apiOrigin,
        requestId,
        ...(data ? { intentProof: proof } : {}),
        sub: identity.user.id,
        name: identity.user.name,
        sessionExpiresAt: new Date(identity.session.expiresAt).toISOString(),
        exp: Date.now() + 60_000,
      });
      const response = await fetcher(config.apiOrigin + "/auth/approve", {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(20000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload, signature: signature(payload) }),
      });
      const result = await response.json();
      if (!response.ok)
        return res
          .status(response.status === 409 ? 409 : 502)
          .send(
            response.status === 409
              ? "账号不一致或请求已使用，请切换到插件账号后重新连接。"
              : "登录未完成，请重新连接。",
          );
      const callback = new URL(result.callbackUrl);
      const extension =
        callback.protocol === "https:" &&
        /^[a-p]{32}\.chromiumapp\.org$/.test(callback.host) &&
        callback.pathname === "/page-review" &&
        !callback.username &&
        !callback.password;
      const cli =
        result.access === "reader" &&
        callback.protocol === "http:" &&
        callback.hostname === "127.0.0.1" &&
        Number(callback.port) >= 1024 &&
        Number(callback.port) <= 65535 &&
        callback.pathname === "/callback" &&
        !callback.username &&
        !callback.password;
      if (
        !(extension || cli) ||
        callback.hash ||
        [...callback.searchParams.keys()].some(
          (k) => !["code", "state"].includes(k),
        ) ||
        !valid(callback.searchParams.get("code")) ||
        !valid(callback.searchParams.get("state"))
      )
        return res.status(502).send("登录回跳校验失败");
      return res.json({ callbackUrl: callback.href });
    } catch {
      return res.status(503).send("登录暂时不可用，你的本机标注仍保留。");
    }
  };
}
