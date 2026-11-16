import { createHmac, timingSafeEqual } from "node:crypto";
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
export function createPageReviewBridge({
  getIdentity,
  readConfig,
  loginOrigin,
  layout,
  fetcher = fetch,
}) {
  return async function pageReview(req, res, next) {
    if (req.path !== "/page-review/authorize") return next();
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
      const identity = await getIdentity(req);
      if (!identity)
        return res.redirect(
          "/login?next=" + encodeURIComponent(req.originalUrl),
        );
      let requestId = String(req.query.request_id || ""),
        csrf = "";
      if (req.method === "POST") {
        if (
          req.headers.origin !== loginOrigin ||
          req.headers["content-type"]?.split(";")[0] !==
            "application/x-www-form-urlencoded"
        )
          return res.status(403).send("请从登录页面继续");
        let body = "";
        for await (const chunk of req) {
          body += chunk.toString();
          if (Buffer.byteLength(body) > 2048)
            return res.status(413).send("请求过大");
        }
        const form = new URLSearchParams(body);
        requestId = form.get("request_id");
        csrf = form.get("csrf");
      }
      if (!valid(requestId))
        return res.status(400).send("请从Page Review插件重新开始登录");
      const signature = (value) =>
        createHmac("sha256", config.key).update(value).digest("base64url");
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
      const payload = JSON.stringify({
        iss: loginOrigin,
        aud: config.apiOrigin,
        requestId,
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
          .send("登录未完成，请从插件重新开始。");
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
