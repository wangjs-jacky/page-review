// Application-specific sign-in bridge. The existing identity service owns GitHub/Google OAuth.
const enc = new TextEncoder();
const b64 = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const random = () => b64(crypto.getRandomValues(new Uint8Array(32)));
const sha = async (value) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value)))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
const pkce = async (value) =>
  b64(await crypto.subtle.digest("SHA-256", enc.encode(value)));
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "private, no-store",
      "referrer-policy": "no-referrer",
    },
  });
const redirect = (url) =>
  new Response(null, {
    status: 302,
    headers: {
      location: String(url),
      "cache-control": "private, no-store",
      "referrer-policy": "no-referrer",
    },
  });
const valid = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
async function input(request) {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    return null;
  // All bridge messages are tiny; avoid accepting arbitrary unbounded login payloads.
  const chunks = [];
  let size = 0;
  for await (const part of request.body || []) {
    size += part.length;
    if (size > 8192) return null;
    chunks.push(part);
  }
  try {
    const bytes = new Uint8Array(size);
    let i = 0;
    for (const p of chunks) {
      bytes.set(p, i);
      i += p.length;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
export function cliCallback(value) {
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
}
export async function loginRoute(request, env) {
  const url = new URL(request.url),
    path = url.pathname;
  if (!path.startsWith("/auth/")) return null;
  if (!env.LOGIN_BRIDGE_KEY || !env.API_ORIGIN || !env.LOGIN_ORIGIN)
    return json({ message: "登录服务尚未配置" }, 503);
  if (url.origin !== env.API_ORIGIN)
    return json({ message: "请使用当前服务地址登录" }, 400);
  const db = env.DB.withSession ? env.DB.withSession("first-primary") : env.DB;
  if (path === "/auth/request" && request.method === "GET") {
    const id = url.searchParams.get("request_id");
    if (!valid(id)) return json({ message: "登录请求无效" }, 400);
    const row = await db
      .prepare(
        "SELECT client_kind,callback,intent_challenge FROM login_requests WHERE id=? AND expires_at>? AND consumed_at IS NULL AND subject IS NULL",
      )
      .bind(id, Date.now())
      .first();
    if (!row) return json({ message: "登录请求已过期" }, 404);
    return json({
      access: row.client_kind === "reader" ? "reader" : "writer",
      ...(row.intent_challenge
        ? { [row.client_kind === "reader" ? "terminalIntent" : "extensionIntent"]: true, callback: row.callback }
        : {}),
    });
  }
  if (path === "/auth/extension/start" && request.method === "POST") {
    const body = await input(request);
    if (!body || !/^https:\/\/[a-p]{32}\.chromiumapp\.org\/page-review$/.test(body.callback || "") ||
        !valid(body.state) || !valid(body.challenge) || !valid(body.intentChallenge) ||
        (body.workspaceId !== undefined && !/^w-[a-f0-9]{40}$/.test(body.workspaceId)))
      return json({ message: "插件登录参数无效" }, 400);
    const id = random();
    await db.prepare("INSERT INTO login_requests(id,callback,client_state,challenge,expires_at,client_kind,intent_challenge,expected_workspace) VALUES(?,?,?,?,?,'writer',?,?)")
      .bind(id, body.callback, body.state, body.challenge, Date.now() + 5 * 60_000,
        body.intentChallenge, body.workspaceId || null).run();
    const authorize = new URL("/page-review/authorize", env.LOGIN_ORIGIN);
    authorize.searchParams.set("request_id", id);
    return json({ requestId: id, authorizeUrl: authorize.href });
  }
  if (path === "/auth/terminal/start" && request.method === "POST") {
    const body = await input(request);
    if (
      !body ||
      !cliCallback(body.callback) ||
      !valid(body.state) ||
      !valid(body.challenge) ||
      !valid(body.intentChallenge) ||
      (body.workspaceId !== undefined &&
        !/^w-[a-f0-9]{40}$/.test(body.workspaceId))
    )
      return json({ message: "终端连接参数无效" }, 400);
    const id = random();
    await db
      .prepare(
        "INSERT INTO login_requests(id,callback,client_state,challenge,expires_at,client_kind,intent_challenge,expected_workspace) VALUES(?,?,?,?,?,'reader',?,?)",
      )
      .bind(
        id,
        body.callback,
        body.state,
        body.challenge,
        Date.now() + 10 * 60_000,
        body.intentChallenge,
        body.workspaceId || null,
      )
      .run();
    const authorize = new URL("/page-review/authorize", env.LOGIN_ORIGIN);
    authorize.searchParams.set("request_id", id);
    return json({ requestId: id, authorizeUrl: authorize.href });
  }
  if (path === "/auth/start" && request.method === "GET") {
    const callback = url.searchParams.get("redirect_uri"),
      state = url.searchParams.get("state"),
      challenge = url.searchParams.get("code_challenge");
    const kind = url.searchParams.get("client") === "cli" ? "reader" : "writer";
    if (
      !(kind === "reader"
        ? cliCallback(callback)
        : /^https:\/\/[a-p]{32}\.chromiumapp\.org\/page-review$/.test(
            callback || "",
          )) ||
      !valid(state) ||
      !valid(challenge)
    )
      return json({ message: "登录回跳或校验参数无效" }, 400);
    const id = random();
    await db
      .prepare(
        "INSERT INTO login_requests(id,callback,client_state,challenge,expires_at,client_kind) VALUES(?,?,?,?,?,?)",
      )
      .bind(id, callback, state, challenge, Date.now() + 10 * 60_000, kind)
      .run();
    const next = new URL("/page-review/authorize", env.LOGIN_ORIGIN);
    next.searchParams.set("request_id", id);
    return redirect(next);
  }
  if (path === "/auth/approve" && request.method === "POST") {
    const body = await input(request);
    if (
      !body ||
      typeof body.payload !== "string" ||
      body.payload.length > 4096 ||
      !valid(body.signature)
    )
      return json({ message: "身份签名无效" }, 401);
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(env.LOGIN_BRIDGE_KEY),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    let signature;
    try {
      signature = Uint8Array.from(
        atob(body.signature.replace(/-/g, "+").replace(/_/g, "/")),
        (c) => c.charCodeAt(0),
      );
    } catch {
      return json({ message: "身份签名无效" }, 401);
    }
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        key,
        signature,
        enc.encode(body.payload),
      ))
    )
      return json({ message: "身份签名无效" }, 401);
    let identity;
    try {
      identity = JSON.parse(body.payload);
    } catch {
      return json({ message: "身份无效" }, 401);
    }
    if (
      identity.iss !== env.LOGIN_ORIGIN ||
      identity.aud !== env.API_ORIGIN ||
      !valid(identity.requestId) ||
      typeof identity.sub !== "string" ||
      !identity.sub ||
      identity.sub.length > 200 ||
      !Number.isSafeInteger(identity.exp) ||
      identity.exp < Date.now() ||
      identity.exp > Date.now() + 120_000 ||
      !Number.isFinite(Date.parse(identity.sessionExpiresAt)) ||
      Date.parse(identity.sessionExpiresAt) <= Date.now()
    )
      return json({ message: "身份已过期或不适用于此应用" }, 401);
    const pending = await db
      .prepare(
        "SELECT intent_challenge,expected_workspace FROM login_requests WHERE id=? AND expires_at>? AND subject IS NULL AND consumed_at IS NULL",
      )
      .bind(identity.requestId, Date.now())
      .first();
    if (!pending) return json({ message: "登录请求已过期或已使用" }, 409);
    if (
      pending.intent_challenge &&
      (!valid(identity.intentProof) ||
        (await pkce(identity.intentProof)) !== pending.intent_challenge)
    )
      return json({ message: "未验证当前终端" }, 403);
    const expectedWorkspace =
      "w-" + (await sha(env.LOGIN_ORIGIN + "|" + identity.sub)).slice(0, 40);
    if (
      pending.expected_workspace &&
      pending.expected_workspace !== expectedWorkspace
    )
      return json(
        { message: "浏览器账号与插件账号不一致，请切换到插件账号后重试" },
        409,
      );
    const code = random();
    const row = await db
      .prepare(
        "UPDATE login_requests SET subject=?,name=?,session_expires_at=?,code_hash=? WHERE id=? AND expires_at>? AND subject IS NULL AND consumed_at IS NULL RETURNING callback,client_state,client_kind",
      )
      .bind(
        identity.sub,
        String(identity.name || "").slice(0, 100),
        identity.sessionExpiresAt,
        await sha(code),
        identity.requestId,
        Date.now(),
      )
      .first();
    if (!row) return json({ message: "登录请求已过期或已使用" }, 409);
    const callback = new URL(row.callback);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", row.client_state);
    return json({
      callbackUrl: callback.href,
      access: row.client_kind === "reader" ? "reader" : "writer",
    });
  }
  if (path === "/auth/exchange" && request.method === "POST") {
    const body = await input(request);
    if (!body || !valid(body.code) || !valid(body.verifier))
      return json({ message: "登录校验无效" }, 400);
    const row = await db
      .prepare(
        "UPDATE login_requests SET consumed_at=? WHERE code_hash=? AND challenge=? AND expires_at>? AND consumed_at IS NULL AND subject IS NOT NULL RETURNING subject,name,session_expires_at,client_kind",
      )
      .bind(
        new Date().toISOString(),
        await sha(body.code),
        await pkce(body.verifier),
        Date.now(),
      )
      .first();
    if (!row || Date.parse(row.session_expires_at) <= Date.now())
      return json({ message: "登录已过期或已使用，请重新登录" }, 401);
    const subject = env.LOGIN_ORIGIN + "|" + row.subject,
      workspace = "w-" + (await sha(subject)).slice(0, 40),
      now = new Date().toISOString();
    const token =
      "pr_" +
      [...crypto.getRandomValues(new Uint8Array(32))]
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
    const kind = row.client_kind === "reader" ? "reader" : "writer",
      tokenId = crypto.randomUUID();
    // The identity session must be valid at exchange. Each issued connection
    // remains valid until explicitly revoked.
    const expiresAt = null;
    await db.batch([
      db
        .prepare("INSERT OR IGNORE INTO workspaces(id,created_at) VALUES(?,?)")
        .bind(workspace, now),
      db
        .prepare(
          "INSERT INTO users(subject,workspace_id,name,created_at) VALUES(?,?,?,?) ON CONFLICT(subject) DO UPDATE SET name=excluded.name",
        )
        .bind(subject, workspace, row.name, now),
      db
        .prepare(
          "INSERT INTO tokens(id,workspace_id,token_hash,kind,name,created_at,expires_at) VALUES(?,?,?,?,?,?,?)",
        )
        .bind(
          tokenId,
          workspace,
          await sha(token),
          kind,
          kind === "reader" ? "终端只读授权" : "浏览器登录",
          now,
          expiresAt,
        ),
    ]);
    return json({
      token,
      workspaceId: workspace,
      name: row.name,
      expiresAt,
      access: kind,
      connectionId: tokenId,
    });
  }
  return json({ message: "登录接口不存在" }, 404);
}
