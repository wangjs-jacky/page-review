// Explicit synthetic identities; real bridge, CLI, HTTP redirects and workerd/D1.
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import { createPageReviewBridge } from "../../integrations/better-auth/page-review.mjs";
import { connectTerminal, api } from "../../cli/page-review.mjs";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const runtime = await import(
  process.env.PAGE_REVIEW_MINIFLARE_MODULE || "miniflare"
);
const origin = "http://localhost:18800",
  cliApi = "http://127.0.0.1:18800",
  apiOrigin = "https://terminal-fixture.invalid",
  key = randomBytes(32).toString("hex");
const options = {
  modules: ["worker.mjs", "login.mjs", "handoff.mjs", "distribution.mjs", "cli-release.mjs"].map(
    (name) => ({ type: "ESModule", path: path.join(root, "cloud", name) }),
  ),
  modulesRoot: path.join(root, "cloud"),
  compatibilityDate: "2026-10-12",
  host: "127.0.0.1",
  port: 0,
  d1Databases: ["DB"],
  r2Buckets: ["FILES"],
  bindings: {
    API_ORIGIN: apiOrigin,
    LOGIN_ORIGIN: origin,
    LOGIN_BRIDGE_KEY: key,
  },
};
const mf = new runtime.Miniflare(
  runtime.convertV4MiniflareOptions
    ? runtime.convertV4MiniflareOptions(options)
    : options,
);
await mf.ready;
const db = await mf.getD1Database("DB");
for (const f of [
  "0001.sql",
  "0002-login.sql",
  "0003-handoff.sql",
  "0004-terminal-intent.sql", "0005-live-pages.sql", "0006-cli-read-protocol.sql",
])
  for (const q of (
    await fs.readFile(path.join(root, "cloud/migrations", f), "utf8")
  )
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean))
    await db.prepare(q).run();
const sessions = new Map();
let activePromise,
  lastResult = { connected: false },
  opened = 0,
  loginCount = 0;
const file = path.join(root, ".local/terminal-crosssite/connection.json");
await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
const esc = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const document = (content) =>
  `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>终端连接验收 · Page Review</title><body style="font:17px/1.8 system-ui;max-width:860px;margin:80px auto;color:#1d3463"><p>PAGE REVIEW · 隔离本机验收</p>${content}</body></html>`;
const bridge = createPageReviewBridge({
  getIdentity: async (req) => {
    const id = req.headers.cookie?.match(
      /(?:^|; )pr_test_session=([\w-]+)/,
    )?.[1];
    return sessions.get(id) || null;
  },
  readConfig: () => ({ apiOrigin, key }),
  loginOrigin: origin,
  layout: (_t, b, s = "") => document(b + `<script>${s}</script>`),
  fetcher: (url, o) => mf.dispatchFetch(url, o),
});
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, origin);
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "origin");
    const send = (content, type = "text/html; charset=utf-8") => {
      res.setHeader("content-type", type);
      res.end(content);
    };
    if (u.pathname.startsWith("/v1/") || u.pathname.startsWith("/auth/")) {
      const parts = [];
      for await (const b of req) parts.push(b);
      const r = await mf.dispatchFetch(apiOrigin + req.url, {
        method: req.method,
        headers: req.headers,
        ...(parts.length ? { body: Buffer.concat(parts) } : {}),
      });
      res.writeHead(r.status, Object.fromEntries(r.headers));
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    if (u.pathname.startsWith("/page-review/")) {
      req.path = u.pathname;
      req.query = Object.fromEntries(u.searchParams);
      req.originalUrl = req.url;
      res.status = (n) => {
        res.statusCode = n;
        return res;
      };
      res.set = (headers) => {
        for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
        return res;
      };
      res.send = (v) => {
        if (res.statusCode >= 400)
          console.error("bridge-rejection", res.statusCode, String(v));
        send(v);
        return res;
      };
      res.json = (v) => {
        send(JSON.stringify(v), "application/json");
        return res;
      };
      res.redirect = (location) => {
        res.writeHead(302, { location });
        res.end();
        return res;
      };
      return await bridge(req, res, () => {
        res.writeHead(404);
        res.end();
      });
    }
    if (u.pathname === "/login" && req.method === "GET") {
      const next = u.searchParams.get("next") || "/test";
      return send(
        document(
          `<h1>合成账号登录</h1><p>这不是生产 OAuth；只验证真实浏览器 Cookie 与登录后接续。</p><form method="post" action="/test/login"><input type="hidden" name="next" value="${esc(next)}"><button>使用测试账号甲登录</button></form>`,
        ),
      );
    }
    if (u.pathname === "/test/login" && req.method === "POST") {
      if (req.headers.origin !== origin) {
        res.writeHead(403);
        return res.end();
      }
      let body = "";
      for await (const b of req) body += b;
      const next = new URLSearchParams(body).get("next");
      if (!next?.startsWith("/page-review/authorize?")) {
        res.writeHead(400);
        return res.end();
      }
      const id = randomBytes(24).toString("base64url");
      sessions.set(id, {
        user: { id: "test-alice", name: "本机测试账号甲" },
        session: {
          id: randomBytes(16).toString("hex"),
          expiresAt: new Date(Date.now() + 3600000),
        },
      });
      loginCount++;
      res.writeHead(303, {
        "set-cookie": `pr_test_session=${id}; HttpOnly; SameSite=Lax; Path=/`,
        location: next,
      });
      return res.end();
    }
    if (u.pathname === "/test/connect" && req.method === "POST") {
      if (req.headers.origin !== origin) {
        res.writeHead(403);
        return res.end();
      }
      let resolveOpen;
      const opening = new Promise((r) => (resolveOpen = r));
      activePromise = connectTerminal(cliApi, {
        file,
        timeout: 120000,
        open: async (url) => {
          opened++;
          resolveOpen({ url });
        },
      })
        .then((result) => {
          lastResult = result;
          resolveOpen({ url: origin + "/test" });
          return result;
        })
        .catch((error) => {
          lastResult = { connected: false, error: error.message };
          resolveOpen({ url: origin + "/test" });
          return lastResult;
        });
      return send(JSON.stringify(await opening), "application/json");
    }
    if (u.pathname === "/test/revoke" && req.method === "POST") {
      if (req.headers.origin !== origin) {
        res.writeHead(403);
        return res.end();
      }
      const config = JSON.parse(await fs.readFile(file));
      await api(config, "/v1/session", { method: "DELETE" });
      res.writeHead(303, { location: "/test" });
      return res.end();
    }
    if (u.pathname === "/test/result") {
      if (activePromise) await activePromise;
      return send(
        JSON.stringify({ result: lastResult, opened, loginCount }),
        "application/json",
      );
    }
    if (u.pathname === "/test")
      return send(
        document(
          `<h1>终端连接验收</h1><p>真实 CLI + 中央桥 + workerd / D1；身份为独立合成账号。</p><p id="result">${esc(JSON.stringify(lastResult))}</p><p>浏览器打开次数 ${opened} · 身份登录次数 ${loginCount}</p><button id="connect">连接当前终端</button><form method="post" action="/test/revoke"><button>撤销本次终端连接</button></form><script>document.querySelector('#connect').onclick=async()=>{const r=await fetch('/test/connect',{method:'POST'});location.assign((await r.json()).url)}</script>`,
        ),
      );
    res.writeHead(404);
    res.end();
  } catch (error) {
    res.writeHead(500);
    res.end("本机验收错误");
    console.error(error.message);
  }
});
server.listen(18800, "127.0.0.1", () =>
  console.log(
    "隔离终端连接验收 http://localhost:18800/test；身份为合成，协议/存储为实际代码。",
  ),
);
for (const sig of ["SIGINT", "SIGTERM"])
  process.once(sig, async () => {
    server.closeAllConnections();
    server.close();
    await mf.dispose();
    process.exit(0);
  });
