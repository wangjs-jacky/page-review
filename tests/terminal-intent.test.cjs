const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const { setup } = require("./helpers/cloud.cjs");
const issuer = "https://login.test.invalid",
  origin = "https://test.invalid",
  key = "test-only-terminal-intent-key-".repeat(3);
const hash = (value) =>
  crypto.createHash("sha256").update(value).digest("base64url");
const random = () => crypto.randomBytes(32).toString("base64url");
function response() {
  return {
    code: 200,
    status(n) {
      this.code = n;
      return this;
    },
    set() {
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    redirect(location) {
      this.location = location;
      return this;
    },
  };
}
function request(path, method, body = "", requestOrigin = issuer) {
  const u = new URL(path, issuer);
  return {
    path: u.pathname,
    originalUrl: path,
    query: Object.fromEntries(u.searchParams),
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
function fields(html) {
  return Object.fromEntries(
    [...html.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((m) => [
      m[1],
      m[2].replaceAll("&amp;", "&"),
    ]),
  );
}
async function context() {
  const t = await setup();
  Object.assign(t.env, {
    API_ORIGIN: origin,
    LOGIN_ORIGIN: issuer,
    LOGIN_BRIDGE_KEY: key,
  });
  const proof = random(),
    verifier = random(),
    state = random();
  const start = await t.request("/auth/terminal/start", {
    method: "POST",
    data: {
      callback: "http://127.0.0.1:45291/callback",
      state,
      challenge: hash(verifier),
      intentChallenge: hash(proof),
    },
  });
  assert.equal(start.status, 200);
  const pending = await start.json();
  let identity = {
    user: { id: "alice", name: "甲" },
    session: { id: "session-a", expiresAt: new Date(Date.now() + 3600000) },
  };
  const bridge = (
    await import("../integrations/better-auth/page-review.mjs")
  ).createPageReviewBridge({
    getIdentity: async () => identity,
    readConfig: () => ({ apiOrigin: origin, key }),
    loginOrigin: issuer,
    layout: (title, body) => body,
    fetcher: (url, o = {}) =>
      import("../cloud/worker.mjs").then(({ default: w }) =>
        w.fetch(new Request(url, o), t.env),
      ),
  });
  const call = async (req) => {
    const res = response();
    await bridge(req, res, () => {});
    return res;
  };
  const page = await call(
    request("/page-review/authorize?request_id=" + pending.requestId, "GET"),
  );
  return {
    t,
    proof,
    verifier,
    state,
    pending,
    call,
    relay: fields(page.body),
    page,
    setIdentity: (value) => (identity = value),
  };
}
test("新终端自动复用浏览器会话：仅终端在场证明可取reader，PKCE和一次使用保留", async () => {
  const c = await context();
  assert(!c.page.body.includes("授权只读访问"));
  assert.match(c.page.body, /http:\/\/127.0.0.1:45291\/connect/);
  const info = await (
    await c.t.request("/auth/request?request_id=" + c.pending.requestId)
  ).json();
  assert.equal(info.terminalIntent, true);
  const returned = await c.call(
    request(
      "/page-review/terminal-return",
      "POST",
      new URLSearchParams({ ...c.relay, proof: c.proof }).toString(),
      "http://127.0.0.1:45291",
    ),
  );
  assert.equal(returned.code, 200);
  const final = fields(returned.body);
  const approved = await c.call(
    request(
      "/page-review/authorize",
      "POST",
      new URLSearchParams(final).toString(),
    ),
  );
  assert.equal(approved.code, 200);
  assert(approved.body.callbackUrl);
  const u = new URL(approved.body.callbackUrl);
  assert.equal(u.searchParams.get("state"), c.state);
  const exchange = (verifier) =>
    c.t.request("/auth/exchange", {
      method: "POST",
      data: { code: u.searchParams.get("code"), verifier },
    });
  assert.equal((await exchange(random())).status, 401);
  const signed = await (await exchange(c.verifier)).json();
  assert.equal(signed.access, "reader");
  assert.equal((await exchange(c.verifier)).status, 401);
  assert.equal(
    (
      await c.t.request("/v1/annotations/forbidden-write", {
        method: "PUT",
        token: signed.token,
        data: {},
      })
    ).status,
    403,
  );
});
test("陌生授权URL、外站POST、伪造证明、账号变化、过期和取消都不能签发终端凭据", async () => {
  const c = await context(),
    body = new URLSearchParams({ ...c.relay, proof: c.proof }).toString();
  assert.equal(
    (await c.call(request("/page-review/terminal-return", "GET"))).code,
    405,
  );
  assert.equal(
    (
      await c.call(
        request(
          "/page-review/terminal-return",
          "POST",
          body,
          "https://attacker.invalid",
        ),
      )
    ).code,
    403,
  );
  assert.equal(
    (
      await c.call(
        request(
          "/page-review/terminal-return",
          "POST",
          new URLSearchParams({
            ...c.relay,
            relay: c.relay.relay.slice(0, -2) + "xx",
            proof: c.proof,
          }).toString(),
          "http://127.0.0.1:45291",
        ),
      )
    ).code,
    403,
  );
  const returned = await c.call(
      request(
        "/page-review/terminal-return",
        "POST",
        body,
        "http://127.0.0.1:45291",
      ),
    ),
    final = fields(returned.body);
  assert.equal(
    (
      await c.call(
        request(
          "/page-review/authorize",
          "POST",
          new URLSearchParams({ ...final, proof: random() }).toString(),
        ),
      )
    ).code,
    502,
  );
  c.setIdentity({
    user: { id: "bob" },
    session: { id: "session-b", expiresAt: new Date(Date.now() + 3600000) },
  });
  assert.equal(
    (
      await c.call(
        request(
          "/page-review/authorize",
          "POST",
          new URLSearchParams(final).toString(),
        ),
      )
    ).code,
    403,
  );
  c.setIdentity(null);
  assert.equal(
    (
      await c.call(
        request(
          "/page-review/authorize",
          "POST",
          new URLSearchParams(final).toString(),
        ),
      )
    ).code,
    401,
  );
  const anonymous = await c.call(
    request("/page-review/authorize?request_id=" + c.pending.requestId, "GET"),
  );
  assert(anonymous.location.startsWith("/login?next="));
  c.t.sql.prepare("UPDATE login_requests SET expires_at=0").run();
  assert.equal(
    (await c.t.request("/auth/request?request_id=" + c.pending.requestId))
      .status,
    404,
  );
  assert.equal(
    c.t.sql.prepare("SELECT COUNT(*) n FROM tokens WHERE kind='reader'").get()
      .n,
    0,
  );
});
test("插件期待账号绑定在请求中；中央切换账号不能静默连接另一个空间", async () => {
  const c = await context();
  c.t.sql
    .prepare("UPDATE login_requests SET expected_workspace=?")
    .run("w-" + "a".repeat(40));
  const payload = JSON.stringify({
    iss: issuer,
    aud: origin,
    requestId: c.pending.requestId,
    sub: "alice",
    intentProof: c.proof,
    sessionExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    exp: Date.now() + 60000,
  });
  const r = await c.t.request("/auth/approve", {
    method: "POST",
    data: {
      payload,
      signature: crypto
        .createHmac("sha256", key)
        .update(payload)
        .digest("base64url"),
    },
  });
  assert.equal(r.status, 409);
  assert.equal(
    c.t.sql.prepare("SELECT COUNT(*) n FROM tokens WHERE kind='reader'").get()
      .n,
    0,
  );
});
test("终端接收端只接受中央来源且必须是本终端请求，不从URL授予证明", async () => {
  const { terminalRelay } = await import("../cli/terminal-intent.mjs"),
    proof = random(),
    requestId = random();
  async function call(origin, id, method = "POST") {
    let status = 200,
      body;
    const req = {
      method,
      url: "/connect",
      headers: {
        origin,
        host: "127.0.0.1:45291",
        "content-type": "application/x-www-form-urlencoded",
      },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(
          new URLSearchParams({
            request_id: id,
            relay: "aaa." + "x".repeat(43),
          }).toString(),
        );
      },
    };
    const res = {
      writeHead(n) {
        status = n;
      },
      end(v) {
        body = v;
      },
    };
    const handled = await terminalRelay(req, res, {
      callbackOrigin: "http://127.0.0.1:45291",
      loginOrigin: issuer,
      requestId,
      proof,
    });
    return { status, body, handled };
  }
  const rejected = await call("https://attacker.invalid", requestId);
  assert.equal(rejected.status, 403);
  assert.match(rejected.body, /<h1[^>]*>终端连接未完成<\/h1>/);
  assert(!rejected.body.includes(proof));
  assert.equal((await call(issuer, random())).status, 400);
  assert.equal((await call(issuer, requestId, "GET")).handled, false);
  const ok = await call(issuer, requestId);
  assert.equal(ok.status, 200);
  assert.match(ok.body, /<h1[^>]*>正在连接当前终端<\/h1>/);
  assert.match(ok.body, /document.forms\[0\].submit\(\)/);
  assert(ok.body.includes(proof));
});
