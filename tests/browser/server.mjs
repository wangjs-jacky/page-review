// Explicit loopback integration: real extension code + workerd/D1/R2. Native Chrome APIs are adapters.
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID, createHash } from "node:crypto";
const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  ),
  origin =
    "http://127.0.0.1:" + Number(process.env.PAGE_REVIEW_TEST_PORT || 18791),
  runtime = await import(
    process.env.PAGE_REVIEW_MINIFLARE_MODULE || "miniflare"
  ),
  key = randomBytes(32).toString("hex");
const options = {
  modules: ["worker.mjs", "login.mjs", "handoff.mjs", "distribution.mjs"].map(
    (name) => ({ type: "ESModule", path: path.join(root, "cloud", name) }),
  ),
  modulesRoot: path.join(root, "cloud"),
  compatibilityDate: "2026-10-12",
  host: "127.0.0.1",
  port: 0,
  d1Databases: ["DB"],
  r2Buckets: ["FILES", "RELEASES"],
  bindings: { API_ORIGIN: origin, LOGIN_ORIGIN: origin, LOGIN_BRIDGE_KEY: key },
};
const mf = new runtime.Miniflare(
  runtime.convertV4MiniflareOptions
    ? runtime.convertV4MiniflareOptions(options)
    : options,
);
await mf.ready;
const db = await mf.getD1Database("DB");
for (const file of ["0001.sql", "0002-login.sql", "0003-handoff.sql", "0004-terminal-intent.sql"])
  for (const statement of (
    await fs.readFile(path.join(root, "cloud/migrations", file), "utf8")
  )
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean))
    await db.prepare(statement).run();
const token = "pr_" + randomBytes(32).toString("hex"),
  workspaceId = randomUUID(),
  connection = { apiUrl: origin, token, workspaceId };
await db
  .prepare("INSERT INTO workspaces(id,created_at) VALUES(?,?)")
  .bind(workspaceId, new Date().toISOString())
  .run();
await db
  .prepare(
    "INSERT INTO tokens(id,workspace_id,token_hash,kind,name,created_at) VALUES(?,?,?,'writer','本机合成验收',?)",
  )
  .bind(
    randomUUID(),
    workspaceId,
    createHash("sha256").update(token).digest("hex"),
    new Date().toISOString(),
  )
  .run();
await fs.mkdir(path.join(root, ".local/integration"), {
  recursive: true,
  mode: 0o700,
});
await fs.writeFile(
  path.join(root, ".local/integration/owner.json"),
  JSON.stringify(connection),
  { mode: 0o600 },
);
const releases = await mf.getR2Bucket("RELEASES");
async function releaseFiles(dir, base = "") {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const relative = path.posix.join(base, entry.name),
      full = path.join(dir, entry.name);
    if (entry.isDirectory()) await releaseFiles(full, relative);
    else await releases.put(relative, await fs.readFile(full));
  }
}
try {
  await releaseFiles(path.join(root, "dist/cli"));
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const panelAssets = new Set([
  "panel.html", "private-panel-frame.js", "core.js", "media.js", "content-style.js",
]);
async function contentStyles() {
  return "globalThis.PageReviewStyles=" +
    JSON.stringify(await fs.readFile(path.join(root, "extension/content.css"), "utf8")) + ";";
}
const panelServer = http.createServer(async (req, res) => {
  try {
    const name = new URL(req.url, origin).pathname.slice(1);
    if (!panelAssets.has(name) && name !== "panel-adapter.js") {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("cache-control", "no-store");
    if (name === "panel.html") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("content-security-policy", "script-src 'self'; style-src 'self'; img-src data:; media-src data:; object-src 'none'");
      const html = await fs.readFile(path.join(root, "extension", name), "utf8");
      res.end(html.replace("</head>", '<script src="panel-adapter.js"></script></head>'));
    } else {
      res.setHeader("content-type", "application/javascript; charset=utf-8");
      if (name === "panel-adapter.js")
        res.end('globalThis.chrome={runtime:{sendMessage:async()=>({ok:true})}};');
      else if (name === "content-style.js") res.end(await contentStyles());
      else res.end(await fs.readFile(path.join(root, "extension", name)));
    }
  } catch {
    res.writeHead(500).end();
  }
});
await new Promise((resolve) => panelServer.listen(0, "127.0.0.1", resolve));
const panelOrigin = "http://127.0.0.1:" + panelServer.address().port;
const scripts = [
  "/test-config.js",
  "/bridge.js",
  "/recording-adapter.js",
  "/core.js",
  "/media.js",
  "/db.js",
  "/cloud-config.js",
  "/cloud.js",
  "/recorder.js",
  "/background.js",
];
const tags = scripts
  .map((src) => `<script src="${src}" defer></script>`)
  .join("");
const fixture = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>阅读与导航 · 合成验收页</title><style>#page-review-overlay{display:none!important}body{margin:0;background:#fbfcf9;color:#355f51;font:17px/1.85 -apple-system,sans-serif}header,main{max-width:950px;margin:auto;padding:28px}header{border-bottom:1px solid #dce7dc;font:28px Georgia}main{padding-top:60px;display:grid;grid-template-columns:1fr 180px;gap:60px}h1{font:38px Georgia}h2{font-size:24px}section{padding:25px 0}.map{display:flex;background:#edf2e9;padding:20px;gap:20px}.map button{font:inherit;background:white;border:1px solid #dce7dc;padding:20px;cursor:pointer;color:inherit}.map button.active{background:#356450;color:white}aside{border-left:1px solid #dce7dc;padding:12px 22px;height:260px}a{color:inherit}p{color:#71887b}.kicker{font-size:12px;letter-spacing:2px}#feedback{font-size:13px;min-height:30px}</style>${tags}<script src="/content-style.js" defer></script><script src="/private-panel.js" defer></script><script src="/content.js" defer></script></head><body><header>fieldnotes.</header><main><article><span class="kicker">DESIGN NOTES / READING</span><h1 id="target-title">让好内容，更容易被找到。</h1><p>把入口安排在用户的问题旁边。</p><div class="map"><button id="nav-one">找到入口</button><button id="nav-two">就近反馈</button><button id="nav-three">继续阅读</button></div><p id="feedback"></p><section><h2>给阅读一条路</h2><p>目录让读者知道自己在哪里，关联内容让人知道接着读什么。</p></section><section><h2>沿着这个话题，继续读</h2><p>保留必要的来源，让内容可以重新被使用。</p></section></article><aside><strong>本篇目录</strong><p>找到阅读入口</p><p>给阅读一条路</p></aside></main><script src="/fixture-actions.js"></script></body></html>`;
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin),
      pathname = url.pathname;
    res.setHeader("cache-control", "no-store");
    if (
      pathname.startsWith("/v1/") ||
      pathname.startsWith("/auth/") ||
      pathname === "/health" ||
      pathname === "/install.sh" ||
      pathname.startsWith("/releases/")
    ) {
      const chunks = [];
      for await (const b of req) chunks.push(b);
      const response = await mf.dispatchFetch(origin + req.url, {
        method: req.method,
        headers: req.headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    if (/^\/icons\/(16|32|48|128)\.png$/.test(pathname)) { res.setHeader("content-type","image/png");res.end(await fs.readFile(path.join(root,"extension",pathname)));return; }
    let content,
      mime = "application/javascript; charset=utf-8";
    if (pathname === "/reading" || pathname.startsWith("/reading/")) {
      content = fixture;
      mime = "text/html; charset=utf-8";
    } else if (pathname === "/test-config.js")
      content =
        "globalThis.__testConnection=" + JSON.stringify(connection) +
        ";globalThis.__testPanelOrigin=" + JSON.stringify(panelOrigin) +
        ";globalThis.__testInitialSenderUrl=location.href;";
    else if (pathname === "/cloud-config.js")
      content =
        "globalThis.PageReviewCloudConfig={apiOrigin:" +
        JSON.stringify(origin) +
        "};";
    else if (pathname === "/content-style.js") content = await contentStyles();
    else if (pathname === "/content.js")
      content = (await fs.readFile(path.join(root, "extension/content.js"), "utf8"))
        .replaceAll("page-review-overlay", "page-review-integration-overlay");
    else if (pathname === "/fixture-actions.js")
      content =
        "document.querySelectorAll('.map button').forEach(b=>b.onclick=()=>{document.querySelectorAll('.map button').forEach(x=>x.classList.toggle('active',x===b));document.getElementById('feedback').textContent=b.textContent+' · 内容已展开';});";
    else if (
      ["bridge.js", "recording-adapter.js", "offscreen-adapter.js"].includes(
        pathname.slice(1),
      )
    )
      content = await fs.readFile(
        path.join(root, "tests/browser", pathname.slice(1)),
        "utf8",
      );
    else if (/^\/[a-z-]+\.(html|js|css)$/.test(pathname)) {
      content = await fs.readFile(
        path.join(root, "extension", pathname.slice(1)),
      );
      if (pathname.endsWith(".html")) {
        mime = "text/html; charset=utf-8";
        content = String(content);
        if (pathname === "/library.html")
          content = content.replace(
            '<script src="core.js" defer></script>',
            tags,
          );
        else if (pathname === "/offscreen.html")
          content = content.replace(
            '<script src="media.js">',
            '<script src="offscreen-adapter.js"></script><script src="media.js">',
          );
      } else if (pathname.endsWith(".css")) mime = "text/css; charset=utf-8";
    } else {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader("content-type", mime);
    res.end(content);
  } catch (e) {
    res.writeHead(500);
    res.end("本机验收服务错误");
    console.error(e.message);
  }
});
await new Promise((resolve) =>
  server.listen(Number(new URL(origin).port), "127.0.0.1", resolve),
);
console.log(
  "Loopback 集成验收：" +
    origin +
    "/reading；真实workerd/D1/R2，Chrome API和录制输入为明确测试适配。",
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await mf.dispose();
    process.exit(0);
  });
