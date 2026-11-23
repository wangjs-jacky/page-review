const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const { setup } = require("./helpers/cloud.cjs");
const key = "integration-test-only-bridge-key-".repeat(2),
  origin = "https://test.invalid",
  issuer = "https://login.example";
async function fixture() {
  const t = await setup();
  Object.assign(t.env, {
    LOGIN_BRIDGE_KEY: key,
    API_ORIGIN: origin,
    LOGIN_ORIGIN: issuer,
  });
  return t;
}
async function start(t, sub = "user-a", name = "用户甲") {
  const verifier = crypto.randomBytes(32).toString("base64url"),
    state = crypto.randomBytes(32).toString("base64url");
  const q = new URLSearchParams({
    redirect_uri: "https://" + "a".repeat(32) + ".chromiumapp.org/page-review",
    state,
    code_challenge: crypto
      .createHash("sha256")
      .update(verifier)
      .digest("base64url"),
  });
  const r = await t.request("/auth/start?" + q);
  assert.equal(r.status, 302);
  const requestId = new URL(r.headers.get("location")).searchParams.get(
    "request_id",
  );
  const identity = {
    iss: issuer,
    aud: origin,
    sub,
    name,
    requestId,
    sessionExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    exp: Date.now() + 60000,
  };
  const approve = async (value) => {
    const payload = JSON.stringify(value);
    return t.request("/auth/approve", {
      method: "POST",
      data: {
        payload,
        signature: crypto
          .createHmac("sha256", key)
          .update(payload)
          .digest("base64url"),
      },
    });
  };
  return { identity, approve, verifier, state };
}
async function login(t, sub, name) {
  const s = await start(t, sub, name),
    r = await s.approve(s.identity);
  assert.equal(r.status, 200);
  const u = new URL((await r.json()).callbackUrl);
  assert.equal(u.searchParams.get("state"), s.state);
  const code = u.searchParams.get("code");
  const exchange = await t.request("/auth/exchange", {
    method: "POST",
    data: { code, verifier: s.verifier },
  });
  assert.equal(exchange.status, 200);
  return { signed: await exchange.json(), code, ...s };
}
test("登录自动分配私人空间：同身份重登保留空间，不同用户隔离且不会取得旧拥有者空间", async () => {
  const t = await fixture(),
    a = await login(t, "alice", "甲"),
    again = await login(t, "alice", "甲"),
    b = await login(t, "bob", "乙");
  assert.equal(a.signed.workspaceId, again.signed.workspaceId);
  assert.notEqual(a.signed.workspaceId, b.signed.workspaceId);
  assert.notEqual(a.signed.workspaceId, "workspace-1");
  assert.notEqual(a.signed.token, again.signed.token);
  const me = await (
    await t.request("/v1/me", { token: a.signed.token })
  ).json();
  assert.equal(me.name, "甲");
  assert.equal(me.access, "writer");
  assert.equal(t.sql.prepare("SELECT COUNT(*) n FROM users").get().n, 2);
});
test("登录凭证由PKCE和一次使用保护；错误校验不消耗有效请求", async () => {
  const t = await fixture(),
    s = await start(t);
  const approved = await s.approve(s.identity),
    url = new URL((await approved.json()).callbackUrl),
    code = url.searchParams.get("code");
  assert.equal((await s.approve(s.identity)).status, 409);
  assert.equal(
    (
      await t.request("/auth/exchange", {
        method: "POST",
        data: { code, verifier: "x".repeat(43) },
      })
    ).status,
    401,
  );
  const valid = () =>
    t.request("/auth/exchange", {
      method: "POST",
      data: { code, verifier: s.verifier },
    });
  assert.equal((await valid()).status, 200);
  assert.equal((await valid()).status, 401);
});
test("拒绝伪造身份、错误issuer/audience、过期证明和任意回跳；不会创建空间", async () => {
  const t = await fixture(),
    s = await start(t);
  for (const patch of [
    { iss: "https://evil.example" },
    { aud: "https://evil.example" },
    { exp: Date.now() - 1 },
    { sessionExpiresAt: "not-a-date" },
  ])
    assert.equal((await s.approve({ ...s.identity, ...patch })).status, 401);
  assert.equal(
    (
      await t.request("/auth/approve", {
        method: "POST",
        data: {
          payload: JSON.stringify(s.identity),
          signature: "a".repeat(43),
        },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await t.request(
        "/auth/start?" +
          new URLSearchParams({
            redirect_uri: "https://evil.example/page-review",
            state: s.state,
            code_challenge: "a".repeat(43),
          }),
      )
    ).status,
    400,
  );
  assert.equal(t.sql.prepare("SELECT COUNT(*) n FROM users").get().n, 0);
});
test("浏览器授权在中央会话到期后仍可写入，退出后撤销且保留独立只读授权", async (testContext) => {
  const t = await fixture(),
    { signed } = await login(t);
  const reader = await (
    await t.request("/v1/connections", {
      token: signed.token,
      method: "POST",
      data: { name: "我的AI" },
    })
  ).json();
  testContext.mock.timers.enable({ apis: ["Date"], now: Date.now() + 31 * 24 * 3600_000 });
  const path = "/v1/annotations/permanent-writer-note";
  const save = (token, expectedRevision) =>
    t.request(path, {
      token,
      method: "PUT",
      data: { note: t.note, assets: [], requestId: crypto.randomUUID(), expectedRevision },
    });
  assert.equal((await save(signed.token, 0)).status, 200);
  assert.equal(signed.expiresAt, null);
  assert.equal(
    t.sql.prepare("SELECT expires_at FROM tokens WHERE id=?")
      .get(signed.connectionId).expires_at,
    null,
  );
  assert.equal(
    (
      await t.request("/v1/session", {
        method: "DELETE",
        token: signed.token,
      })
    ).status,
    200,
  );
  assert.equal((await t.request("/v1/me", { token: signed.token })).status, 401);
  assert.equal((await save(signed.token, 1)).status, 401);
  const read = await t.request(path + "/context", { token: reader.token });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).comment, t.note.comment);
});
test("已有的限时浏览器授权仍按原时点失效", async (testContext) => {
  const t = await fixture(), { signed } = await login(t);
  testContext.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const expiresAt = Date.now() + 1000;
  t.sql.prepare("UPDATE tokens SET expires_at=? WHERE id=?")
    .run(new Date(expiresAt).toISOString(), signed.connectionId);
  const me = () => t.request("/v1/me", { token: signed.token });
  assert.equal((await me()).status, 200);
  testContext.mock.timers.setTime(expiresAt);
  assert.equal((await me()).status, 401);
});
test("浏览器登录码换取授权时仍须持有未过期的中央会话", async (testContext) => {
  const t = await fixture();
  testContext.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const s = await start(t);
  const sessionExpiresAt = Date.now() + 1000;
  const approved = await s.approve({
    ...s.identity,
    sessionExpiresAt: new Date(sessionExpiresAt).toISOString(),
  });
  assert.equal(approved.status, 200);
  const code = new URL((await approved.json()).callbackUrl).searchParams.get("code");
  testContext.mock.timers.setTime(sessionExpiresAt);
  assert.equal(
    (
      await t.request("/auth/exchange", {
        method: "POST",
        data: { code, verifier: s.verifier },
      })
    ).status,
    401,
  );
  assert.equal(t.sql.prepare("SELECT COUNT(*) n FROM users").get().n, 0);
});
test("中央接入只接受本人会话及同源确认，证明由服务端签发，不接收客户端user ID", async () => {
  const { createPageReviewBridge } = await import(
    "../integrations/better-auth/page-review.mjs"
  );
  let identity = {
      user: { id: "alice", name: "甲" },
      session: { id: "session-a", expiresAt: new Date(Date.now() + 3600000) },
    },
    calls = [];
  const bridge = createPageReviewBridge({
    getIdentity: async () => identity,
    readConfig: () => ({ apiOrigin: origin, key }),
    loginOrigin: issuer,
    layout: (t, c) => c,
    fetcher: async (url, o) => {
      if (url.includes("/auth/request?"))
        return new Response(JSON.stringify({ access: "writer" }));
      calls.push(JSON.parse(o.body));
      return new Response(
        JSON.stringify({
          callbackUrl:
            "https://" +
            "a".repeat(32) +
            ".chromiumapp.org/page-review?code=" +
            "c".repeat(43) +
            "&state=" +
            "s".repeat(43),
        }),
      );
    },
  });
  const id = "r".repeat(43);
  function req(method = "GET", body = "", requestOrigin = issuer) {
    return {
      path: "/page-review/authorize",
      originalUrl: "/page-review/authorize?request_id=" + id,
      query: { request_id: id },
      method,
      headers: {
        origin: requestOrigin,
        "content-type": "application/x-www-form-urlencoded",
      },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(body);
      },
    };
  }
  function res() {
    return {
      code: 200,
      status(n) {
        this.code = n;
        return this;
      },
      send(v) {
        this.body = v;
        return this;
      },
      json(v) {
        this.body = v;
        return this;
      },
      redirect(a, b) {
        this.location = b || a;
        this.code = b ? a : 302;
        return this;
      },
    };
  }
  const get = res();
  await bridge(req(), get, () => {});
  const csrf = get.body.match(/name="csrf" value="([^"]+)"/)[1];
  const body = new URLSearchParams({
    request_id: id,
    csrf,
    userId: "attacker",
  }).toString();
  const bad = res();
  await bridge(req("POST", body, "https://evil.example"), bad, () => {});
  assert.equal(bad.code, 403);
  assert.equal(calls.length, 0);
  const good = res();
  await bridge(req("POST", body), good, () => {});
  assert.equal(good.code, 200);
  assert(good.body.callbackUrl);
  assert.equal(JSON.parse(calls[0].payload).sub, "alice");
  assert.equal(
    calls[0].signature,
    crypto
      .createHmac("sha256", key)
      .update(calls[0].payload)
      .digest("base64url"),
  );
  identity = null;
  const anon = res();
  await bridge(req(), anon, () => {});
  assert(anon.location.startsWith("/login?next="));
});
test("CLI使用loopback+PKCE一次授权，只获得reader，不能借回跳获取writer", async () => {
  const t = await fixture(),
    verifier = crypto.randomBytes(32).toString("base64url"),
    state = crypto.randomBytes(32).toString("base64url"),
    q = {
      client: "cli",
      redirect_uri: "http://127.0.0.1:45001/callback",
      state,
      code_challenge: crypto
        .createHash("sha256")
        .update(verifier)
        .digest("base64url"),
    };
  for (const bad of [
    "http://localhost:45001/callback",
    "https://evil.example/callback",
    "http://127.0.0.1:80/callback",
    "http://127.0.0.1:45001/callback?next=evil",
  ])
    assert.equal(
      (
        await t.request(
          "/auth/start?" + new URLSearchParams({ ...q, redirect_uri: bad }),
        )
      ).status,
      400,
    );
  const start = await t.request("/auth/start?" + new URLSearchParams(q));
  assert.equal(start.status, 302);
  const requestId = new URL(start.headers.get("location")).searchParams.get(
      "request_id",
    ),
    payload = JSON.stringify({
      iss: issuer,
      aud: origin,
      sub: "cli-user",
      requestId,
      sessionExpiresAt: new Date(Date.now() + 3600000).toISOString(),
      exp: Date.now() + 60000,
    });
  const approved = await t.request("/auth/approve", {
      method: "POST",
      data: {
        payload,
        signature: crypto
          .createHmac("sha256", key)
          .update(payload)
          .digest("base64url"),
      },
    }),
    callback = new URL((await approved.json()).callbackUrl);
  assert.equal(callback.origin, "http://127.0.0.1:45001");
  const signed = await (
    await t.request("/auth/exchange", {
      method: "POST",
      data: { code: callback.searchParams.get("code"), verifier },
    })
  ).json();
  assert.equal(signed.access, "reader");
  assert.equal(
    (await t.request("/v1/me", { token: signed.token })).status,
    200,
  );
  assert.equal(
    (
      await t.request("/v1/connections", {
        token: signed.token,
        method: "POST",
        data: {},
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await t.request("/auth/exchange", {
        method: "POST",
        data: { code: callback.searchParams.get("code"), verifier },
      })
    ).status,
    401,
  );
});
test("登录桥从服务端核对CLI权限并允许只读loopback回跳，不信任客户端权限提示", async () => {
  const t = await fixture(),
    { createPageReviewBridge } = await import(
      "../integrations/better-auth/page-review.mjs"
    ),
    verifier = crypto.randomBytes(32).toString("base64url"),
    state = crypto.randomBytes(32).toString("base64url"),
    q = new URLSearchParams({
      client: "cli",
      redirect_uri: "http://127.0.0.1:45001/callback",
      state,
      code_challenge: crypto
        .createHash("sha256")
        .update(verifier)
        .digest("base64url"),
    });
  const started = await t.request("/auth/start?" + q),
    requestId = new URL(started.headers.get("location")).searchParams.get(
      "request_id",
    ),
    identity = {
      user: { id: "cli-real-bridge", name: "CLI测试" },
      session: {
        id: "cli-test-session",
        expiresAt: new Date(Date.now() + 3600000),
      },
    };
  const metadata = await (
    await t.request("/auth/request?request_id=" + requestId)
  ).json();
  assert.deepEqual(metadata, { access: "reader" });
  const bridge = createPageReviewBridge({
    getIdentity: async () => identity,
    readConfig: () => ({ apiOrigin: origin, key }),
    loginOrigin: issuer,
    layout: (title, content) => content,
    fetcher: (url, options = {}) =>
      import("../cloud/worker.mjs").then(({ default: worker }) =>
        worker.fetch(new Request(url, options), t.env),
      ),
  });
  const req = (method, body = "") => ({
      path: "/page-review/authorize",
      originalUrl: "/page-review/authorize?request_id=" + requestId,
      query: { request_id: requestId, client: "writer" },
      method,
      headers: {
        origin: issuer,
        "content-type": "application/x-www-form-urlencoded",
      },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(body);
      },
    }),
    res = () => ({
      code: 200,
      status(n) {
        this.code = n;
        return this;
      },
      send(value) {
        this.body = value;
        return this;
      },
      json(value) {
        this.body = value;
        return this;
      },
    });
  const get = res();
  await bridge(req("GET"), get, () => {});
  assert.match(get.body, /授权只读访问/);
  assert(!get.body.includes("登录并开启同步"));
  const csrf = get.body.match(/name="csrf" value="([^"]+)"/)[1],
    post = res();
  await bridge(
    req(
      "POST",
      new URLSearchParams({ request_id: requestId, csrf }).toString(),
    ),
    post,
    () => {},
  );
  assert.equal(post.code, 200);
  const callback = new URL(post.body.callbackUrl);
  assert.equal(callback.origin, "http://127.0.0.1:45001");
  const signed = await (
    await t.request("/auth/exchange", {
      method: "POST",
      data: { code: callback.searchParams.get("code"), verifier },
    })
  ).json();
  assert.equal(signed.access, "reader");
});
