const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path"),
  { setup } = require("./helpers/cloud.cjs");
test("CLI PKCE回跳、私有配置、全部媒体固定引用读取、损坏附件不交付部分结果", async () => {
  const { storeConfig, readHandoff, login } = await import(
      process.env.PAGE_REVIEW_TEST_BUNDLE || "../cli/page-review.mjs"
    ),
    t = await setup(),
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "page-review-cli-"));
  const { createServer } = require("node:http"),
    key = "test-only-local-identity";
  let base;
  const worker = (await import("../cloud/worker.mjs")).default;
  const server = createServer(async (req, res) => {
    const data = [];
    for await (const c of req) data.push(c);
    const r = await worker.fetch(
      new Request(base + req.url, {
        method: req.method,
        headers: req.headers,
        ...(data.length ? { body: Buffer.concat(data) } : {}),
      }),
      t.env,
    );
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + server.address().port;
  Object.assign(t.env, {
    API_ORIGIN: base,
    LOGIN_ORIGIN: "https://test-login.invalid",
    LOGIN_BRIDGE_KEY: key,
  });
  const configFile = path.join(temp, "private/connection.json");
  try {
    const logged = await login(base, {
      file: configFile,
      open: async (url) => {
        const started = await fetch(url, { redirect: "manual" }),
          requestId = new URL(started.headers.get("location")).searchParams.get(
            "request_id",
          ),
          payload = JSON.stringify({
            iss: t.env.LOGIN_ORIGIN,
            aud: base,
            sub: "test-cli",
            requestId,
            name: "test",
            sessionExpiresAt: new Date(Date.now() + 3600000).toISOString(),
            exp: Date.now() + 60000,
          }),
          signature = require("node:crypto")
            .createHmac("sha256", key)
            .update(payload)
            .digest("base64url"),
          approved = await fetch(base + "/auth/approve", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ payload, signature }),
          });
        const valid = new URL((await approved.json()).callbackUrl);
        const invalid = new URL(valid);
        invalid.searchParams.set("state", "invalid-test-state");
        const rejected = await fetch(invalid);
        assert.equal(rejected.status, 400);
        assert.match(rejected.headers.get("content-type"), /^text\/html/);
        const rejectedPage = await rejected.text();
        assert.match(rejectedPage, /<h1[^>]*>授权校验失败<\/h1>/);
        assert(!rejectedPage.includes("invalid-test-state"));
        const accepted = await fetch(valid);
        assert.equal(accepted.status, 200);
        assert.match(accepted.headers.get("content-security-policy"), /style-src 'nonce-/);
        const acceptedPage = await accepted.text();
        assert.match(acceptedPage, /<h1[^>]*>已收到授权<\/h1>/);
        assert.match(acceptedPage, /返回发起登录的终端/);
        assert(!acceptedPage.includes(valid.searchParams.get("code")));
      },
    });
    assert.equal(logged.access, "reader");
    assert.equal((await fs.stat(configFile)).mode & 0o777, 0o600);
    const privateConfig = JSON.parse(await fs.readFile(configFile));
    const r = await t.reader();
    await t.request("/v1/cli/confirm", {
      method: "POST",
      token: r.token,
      data: { deviceName: "Test Mac" },
    });
    const asset = await t.upload();
    await t.save("annotation-1", { hasImage: true }, 0, crypto.randomUUID(), [
      asset,
    ]);
    const h = await (
      await t.request("/v1/handoffs", {
        method: "POST",
        data: {
          pageUrl: t.note.url,
          localRecords: [{ id: "annotation-1", revision: 1 }],
        },
      })
    ).json();
    const config = { apiUrl: base, token: r.token },
      out = path.join(temp, "read");
    const result = await readHandoff(config, h.id, out);
    assert.equal(result.annotations, 1);
    assert.equal(result.assets, 1);
    assert.equal((await fs.stat(result.context)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(result.directory)).mode & 0o777, 0o700);
    assert(!JSON.stringify(result).includes(r.token));
    const tampered = t.objects.get("workspace-1/" + asset.id);
    t.objects.set(
      "workspace-1/" + asset.id,
      new Uint8Array(tampered).map((x, i) => (i === 10 ? x ^ 1 : x)),
    );
    await assert.rejects(
      readHandoff(config, h.id, path.join(temp, "bad")),
      /校验失败/,
    );
    await assert.rejects(fs.stat(path.join(temp, "bad")), /ENOENT/);
    t.objects.set("workspace-1/" + asset.id, tampered);
    assert(privateConfig.token);
    const target = path.join(temp, "target.json");
    await fs.writeFile(target, "untouched");
    await fs.symlink(target, path.join(temp, "symlink.json"));
    await assert.rejects(
      storeConfig(config, path.join(temp, "symlink.json")),
      /不安全/,
    );
    assert.equal(await fs.readFile(target, "utf8"), "untouched");
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("CLI 只接受匹配本次请求的取消回调，既有配置保留", async () => {
  const { login } = await import(
    process.env.PAGE_REVIEW_TEST_BUNDLE || "../cli/page-review.mjs"
  );
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "page-review-cancel-"));
  const file = path.join(dir, "connection.json");
  await fs.writeFile(file, "previous-connection");
  try {
    await assert.rejects(
      login("http://127.0.0.1:1", {
        file,
        open: async (url) => {
          const start = new URL(url);
          const callback = new URL(start.searchParams.get("redirect_uri"));
          callback.searchParams.set("error", "access_denied");
          callback.searchParams.set("state", "other-request");
          const mismatch = await fetch(callback);
          assert.equal(mismatch.status, 400);
          assert.match(await mismatch.text(), /<h1[^>]*>授权校验失败<\/h1>/);
          callback.searchParams.set("state", start.searchParams.get("state"));
          const denied = await fetch(callback);
          assert.equal(denied.status, 400);
          assert.match(await denied.text(), /<h1[^>]*>已取消授权<\/h1>/);
        },
      }),
      /已取消授权/,
    );
    assert.equal(await fs.readFile(file, "utf8"), "previous-connection");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
