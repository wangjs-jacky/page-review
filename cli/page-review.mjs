#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { terminalRelay } from "./terminal-intent.mjs";
import {
  configPath,
  readConfigFile,
  validateConfig,
  verifyReader,
} from "../agent-skills/page-review/scripts/connection.mjs";
export const VERSION = "0.4.2",
  DEFAULT_API = "https://review.paws.rodeo";
const hash = (data) => createHash("sha256").update(data).digest("hex");
function origin(value) {
  const u = new URL(value);
  if (
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash ||
    !(
      u.protocol === "https:" ||
      (u.protocol === "http:" && u.hostname === "127.0.0.1")
    )
  )
    throw Error("API需要HTTPS源地址；本机验证仅允许127.0.0.1");
  return u.origin;
}
export async function api(config, resource, options = {}) {
  const target = new URL(resource, config.apiUrl);
  if (target.origin !== config.apiUrl || !target.pathname.startsWith("/v1/"))
    throw Error("拒绝跨站或非API请求");
  let r;
  try {
    r = await fetch(target, {
      ...options,
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
      headers: { ...options.headers, Authorization: "Bearer " + config.token },
    });
  } catch {
    throw Error("无法连接Page Review，请检查网络后手动重试");
  }
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    const error = Error(
      `Page Review ${r.status}：${e.message || "连接失效或资料不可用"}`,
    );
    error.status = r.status;
    throw error;
  }
  return r;
}
export async function storeConfig(config, file = configPath()) {
  validateConfig(config);
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const d = await fs.lstat(dir);
  if (
    !d.isDirectory() ||
    d.isSymbolicLink() ||
    (process.getuid && d.uid !== process.getuid())
  )
    throw Error("配置目录不安全");
  await fs.chmod(dir, 0o700);
  try {
    const old = await fs.lstat(file);
    if (
      !old.isFile() ||
      old.isSymbolicLink() ||
      (process.getuid && old.uid !== process.getuid())
    )
      throw Error("配置文件不安全");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const tmp = file + "." + randomBytes(8).toString("hex") + ".tmp";
  try {
    await fs.writeFile(tmp, JSON.stringify(config, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}
export async function confirm(config) {
  await verifyReader(config);
  return (
    await api(config, "/v1/cli/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceName: os.hostname().slice(0, 80) }),
    })
  ).json();
}
export async function login(
  apiUrl = DEFAULT_API,
  {
    open = (url) =>
      new Promise((resolve, reject) =>
        execFile("/usr/bin/open", [url], (e) => (e ? reject(e) : resolve())),
      ),
    file = configPath(),
    timeout = 180000,
    terminalIntent = false,
    workspaceId,
  } = {},
) {
  apiUrl = origin(apiUrl);
  const verifier = randomBytes(32).toString("base64url"),
    state = randomBytes(32).toString("base64url"),
    proof = randomBytes(32).toString("base64url");
  let pending;
  let resolveCallback, rejectCallback;
  const callback = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  callback.catch(() => {});
  const server = http.createServer(async (req, res) => {
    try {
      if (terminalIntent && pending && (await terminalRelay(req, res, pending)))
        return;
      const u = new URL(req.url, "http://127.0.0.1");
      res.setHeader("cache-control", "no-store");
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.setHeader("x-content-type-options", "nosniff");
      if (
        req.method !== "GET" ||
        u.pathname !== "/callback" ||
        u.searchParams.get("state") !== state ||
        !/^[A-Za-z0-9_-]{43}$/.test(u.searchParams.get("code") || "")
      ) {
        res.writeHead(400);
        res.end("授权校验失败，请回到终端重试");
        return;
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      const nonce = randomBytes(18).toString("base64url");
      res.setHeader(
        "content-security-policy",
        `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'`,
      );
      res.end(
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>终端连接 · Page Review</title><body><p>已收到授权，请回到终端。</p><script nonce="${nonce}">history.replaceState(null,"","/connected")</script></body></html>`,
      );
      resolveCallback(u.searchParams.get("code"));
    } catch {
      res.writeHead(400);
      res.end("终端连接请求无效");
    }
  });
  const timer = setTimeout(
    () => rejectCallback(Error("浏览器授权超时，请重新运行 page-review login")),
    timeout,
  );
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const start = new URL("/auth/start", apiUrl);
    for (const [k, v] of Object.entries({
      client: "cli",
      redirect_uri: `http://127.0.0.1:${server.address().port}/callback`,
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    }))
      start.searchParams.set(k, v);
    if (terminalIntent) {
      const response = await fetch(apiUrl + "/auth/terminal/start", {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(20000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          callback: start.searchParams.get("redirect_uri"),
          state,
          challenge: start.searchParams.get("code_challenge"),
          intentChallenge: createHash("sha256")
            .update(proof)
            .digest("base64url"),
          ...(workspaceId ? { workspaceId } : {}),
        }),
      });
      if (!response.ok) throw Error("服务暂不支持简化连接，请更新服务后重试");
      const value = await response.json(),
        authorize = new URL(value.authorizeUrl);
      if (
        !/^[A-Za-z0-9_-]{43}$/.test(value.requestId || "") ||
        authorize.pathname !== "/page-review/authorize" ||
        authorize.username ||
        authorize.password ||
        authorize.hash ||
        authorize.search !== "?request_id=" + value.requestId ||
        !(
          authorize.protocol === "https:" ||
          (authorize.protocol === "http:" &&
            new URL(apiUrl).protocol === "http:" &&
            ["127.0.0.1", "localhost"].includes(authorize.hostname))
        )
      )
        throw Error("登录服务返回无效连接");
      pending = {
        callbackOrigin: new URL(start.searchParams.get("redirect_uri")).origin,
        loginOrigin: authorize.origin,
        requestId: value.requestId,
        proof,
      };
      await open(authorize.href);
    } else await open(start.href);
    const code = await callback;
    const r = await fetch(apiUrl + "/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, verifier }),
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw Error("登录未完成，请重新运行 page-review login");
    const signed = await r.json(),
      config = {
        ...validateConfig({ apiUrl, token: signed.token }),
        expiresAt: signed.expiresAt,
      };
    if (signed.access !== "reader") throw Error("拒绝保存非只读授权");
    await verifyReader(config);
    await storeConfig(config, file);
    await confirm(await readConfigFile(file));
    return { connected: true, apiUrl, access: "reader" };
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
export async function connectTerminal(apiUrl = DEFAULT_API, options = {}) {
  apiUrl = origin(apiUrl);
  const file = options.file || configPath();
  let existing;
  try {
    await fs.lstat(file);
    existing = await readConfigFile(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing && existing.apiUrl === apiUrl) {
    let who;
    try {
      who = await verifyReader(existing);
    } catch (error) {
      if (error.status !== 401 && !/过期/.test(error.message)) throw error;
    }
    if (who) {
      if (options.workspaceId && who.workspaceId !== options.workspaceId)
        throw Error("终端账号与插件账号不一致，请先退出此终端连接");
      await confirm(existing);
      return { connected: true, apiUrl, access: "reader", reused: true };
    }
  }
  return login(apiUrl, { ...options, file, terminalIntent: true });
}
async function bounded(response, maximum) {
  const length = Number(response.headers.get("content-length") || 0);
  if (length > maximum) throw Error("附件超过读取上限");
  const parts = [];
  let size = 0;
  try {
    for await (const b of response.body) {
      size += b.length;
      if (size > maximum) throw Error("附件超过读取上限");
      parts.push(b);
    }
  } catch {
    throw Error("附件传输中断，未交付不完整资料，请手动重试");
  }
  return Buffer.concat(parts);
}
export async function readHandoff(config, id, out) {
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(id || "")) throw Error("交接ID无效");
  await verifyReader(config);
  const handoff = JSON.parse(
    (
      await bounded(await api(config, "/v1/handoffs/" + id), 1600000)
    ).toString(),
  );
  if (
    handoff.id !== id ||
    handoff.format !== "page-review-handoff" ||
    !Array.isArray(handoff.records) ||
    !handoff.records.length ||
    handoff.records.length > 500
  )
    throw Error("交接清单不完整");
  out = path.resolve(out || path.join(process.cwd(), "page-review-" + id));
  try {
    await fs.lstat(out);
    throw Error("输出目录已存在，请指定新的 --out 目录");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  await fs.mkdir(path.dirname(out), { recursive: true });
  const temp = await fs.mkdtemp(path.join(path.dirname(out), ".page-review-"));
  await fs.chmod(temp, 0o700);
  try {
    const downloaded = new Map();
    for (const record of handoff.records) {
      if (
        !/^[a-zA-Z0-9-]{8,80}$/.test(record.id) ||
        !Array.isArray(record.assets) ||
        record.assets.length > 10
      )
        throw Error("评注附件清单无效");
      for (const asset of record.assets) {
        if (
          !/^[a-f0-9]{64}$/.test(asset.sha256) ||
          asset.path !== `/v1/handoffs/${id}/assets/${asset.sha256}`
        )
          throw Error("拒绝未授权附件引用");
        if (!downloaded.has(asset.sha256)) {
          const r = await api(config, asset.path),
            mime = r.headers.get("content-type")?.split(";")[0],
            extension = {
              "image/png": ".png",
              "image/jpeg": ".jpg",
              "video/webm": ".webm",
            }[mime];
          if (!extension) throw Error("附件类型不支持");
          const data = await bounded(
            r,
            mime === "video/webm" ? 32000000 : 8000000,
          );
          if (hash(data) !== asset.sha256)
            throw Error("附件校验失败，未交付不完整资料");
          const name = asset.sha256 + extension;
          await fs.writeFile(path.join(temp, name), data, {
            mode: 0o600,
            flag: "wx",
          });
          downloaded.set(asset.sha256, name);
        }
        asset.localPath = path.join(out, downloaded.get(asset.sha256));
      }
    }
    await fs.writeFile(
      path.join(temp, "context.json"),
      JSON.stringify(handoff, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    await fs.rename(temp, out);
    return {
      directory: out,
      context: path.join(out, "context.json"),
      annotations: handoff.records.length,
      assets: downloaded.size,
      records: handoff.records,
    };
  } catch (e) {
    await fs.rm(temp, { recursive: true, force: true });
    throw e;
  }
}
export async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  function option(name) {
    const i = rest.indexOf(name);
    if (i < 0) return undefined;
    if (!rest[i + 1] || rest[i + 1].startsWith("--"))
      throw Error(name + " 缺少参数");
    return rest[i + 1];
  }
  if (command === "--version" || command === "version") {
    console.log(VERSION);
    return;
  }
  if (command === "login" || (command === "connect" && !option("--from"))) {
    console.error("正在连接终端；浏览器已登录时会自动继续。");
    console.log(
      JSON.stringify(
        await connectTerminal(option("--api") || DEFAULT_API, {
          workspaceId: option("--workspace"),
        }),
      ),
    );
    return;
  }
  if (command === "connect") {
    const from = option("--from");
    if (!from || !path.isAbsolute(from))
      throw Error("请使用 connect --from 配置文件绝对路径");
    const c = await readConfigFile(from, { importing: true });
    await verifyReader(c);
    await storeConfig(c);
    await confirm(await readConfigFile(configPath()));
    console.log(
      JSON.stringify({ connected: true, access: "reader", apiUrl: c.apiUrl }),
    );
    return;
  }
  if (["status", "read", "logout"].includes(command)) {
    const c = await readConfigFile(configPath());
    if (option("--api") && origin(option("--api")) !== c.apiUrl)
      throw Error("当前终端连接属于另一个服务，请先登录对应服务");
    if (command === "status") {
      console.log(JSON.stringify(await confirm(c)));
      return;
    }
    if (command === "logout") {
      try {
        await api(c, "/v1/session", { method: "DELETE" });
      } catch (e) {
        if (e.status !== 401) throw e;
      }
      await fs.rm(configPath());
      console.log(JSON.stringify({ signedOut: true }));
      return;
    }
    console.log(
      JSON.stringify(await readHandoff(c, rest[0], option("--out")), null, 2),
    );
    return;
  }
  console.log(
    "Page Review " +
      VERSION +
      " (macOS)\n\npage-review login\npage-review status\npage-review read <交接ID> [--out 目录]\npage-review logout",
  );
}
if (
  import.meta.main ||
  path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
