const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const root = path.resolve(__dirname, "..");

test("live协议CLI使用新的不可变版本并与公开分发和安装器一致", async () => {
  const cli = await import(process.env.PAGE_REVIEW_TEST_BUNDLE || "../cli/page-review.mjs");
  const delivery = await import("../cloud/distribution.mjs");
  const { renderCliInstaller } = await import("../scripts/render-cli-installer.mjs");
  assert.equal(cli.VERSION, "0.4.4");
  assert.equal(delivery.VERSION, cli.VERSION);
  const installer = await renderCliInstaller("https://install.example");
  assert.match(installer, /^version=0\.4\.4$/m);
  assert.match(installer, /禁止[^\n]*(?:最近记录|全库)/);
});

test("终端确认报告真实CLI版本和读取协议，旧连接可由status更新", async () => {
  const { confirm } = await import(process.env.PAGE_REVIEW_TEST_BUNDLE || "../cli/page-review.mjs");
  let received;
  const server = http.createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/me") return res.end(JSON.stringify({ access: "reader" }));
    received = JSON.parse(await new Promise(resolve => {
      const chunks = []; req.on("data", chunk => chunks.push(chunk)); req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    }));
    res.end(JSON.stringify({ connected: true, access: "reader", readProtocol: received.readProtocol }));
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  try {
    const result = await confirm({ apiUrl: `http://127.0.0.1:${server.address().port}`, token: "test-reader" });
    assert.equal(received.clientVersion, "0.4.4");
    assert.equal(received.readProtocol, 1);
    assert.equal(result.readProtocol, 1);
  } finally {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
});

test("CLI离线公布live及同步门禁能力，不读取连接配置", async () => {
  const command = path.join(root, "cli/page-review.mjs");
  const { stdout } = await exec(process.execPath, [command, "--capabilities"], {
    env: { ...process.env, PAGE_REVIEW_CONFIG: "/nonexistent/page-review-test.json" },
  });
  const result = JSON.parse(stdout);
  assert.equal(result.version, "0.4.4");
  assert.equal(result.livePageReferences, 1);
  assert.equal(result.syncAfter, 1);
  assert.equal((await exec(process.execPath, [command, "--protocol-version"])).stdout.trim(), "1");
});

test("旧服务不支持live时CLI停止在能力检查，不读取其他交接或全库资料", async () => {
  const { readHandoff } = await import(process.env.PAGE_REVIEW_TEST_BUNDLE || "../cli/page-review.mjs");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "page-review-protocol-"));
  const id = "live-" + "a".repeat(64), requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/me") return res.end(JSON.stringify({ access: "reader" }));
    if (req.url === "/v1/capabilities") return res.end(JSON.stringify({ fixedHandoffs: true }));
    res.end(JSON.stringify({ id, format: "page-review-handoff", records: [] }));
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  try {
    await assert.rejects(
      readHandoff({ apiUrl: `http://127.0.0.1:${server.address().port}`, token: "test-reader" }, "page-review-" + id, path.join(dir, "read")),
      /服务.*更新|服务.*不支持/,
    );
    assert.deepEqual(requests, ["/v1/me", "/v1/capabilities"]);
    await assert.rejects(fs.stat(path.join(dir, "read")), { code: "ENOENT" });
  } finally {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("仅有旧版分发包和fixed能力不能宣称live可用", async () => {
  const { capabilities } = await import("../cloud/distribution.mjs");
  const env = {
    API_ORIGIN: "https://install.example",
    RELEASES: {
      async get() { return { body: JSON.stringify({ version: "0.4.3", files: ["page-review-darwin-arm64.tar.gz", "page-review-darwin-x64.tar.gz", "SHA256SUMS"] }) }; },
      async head() { return {}; },
    },
  };
  const result = await capabilities(env);
  assert.equal(result.livePageReferences, 0);
  assert.equal(result.syncAfter, 0);
});

test("完整live引用和同步标记原样限定目标，成功后只交付该页记录", async () => {
  const { readHandoff } = await import(process.env.PAGE_REVIEW_TEST_BUNDLE || "../cli/page-review.mjs");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "page-review-live-cli-"));
  const id = "live-" + "b".repeat(64), marker = crypto.randomUUID(), requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url, after: req.headers["x-page-review-after"] });
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/me") return res.end(JSON.stringify({ access: "reader" }));
    if (req.url === "/v1/capabilities") return res.end(JSON.stringify({ livePageReferences: 1, syncAfter: 1 }));
    res.end(JSON.stringify({ id, format: "page-review-handoff", pageUrl: "https://example.com/correct", records: [{ id: "annotation-live-1", assets: [] }] }));
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  try {
    const result = await readHandoff({ apiUrl: `http://127.0.0.1:${server.address().port}`, token: "test-reader" }, "page-review-" + id, path.join(dir, "read"), { after: marker });
    assert.equal(result.annotations, 1);
    assert.equal(JSON.parse(await fs.readFile(result.context)).pageUrl, "https://example.com/correct");
    assert.deepEqual(requests.map(r => r.path), ["/v1/me", "/v1/capabilities", "/v1/handoffs/" + id]);
    assert.equal(requests.at(-1).after, marker);
  } finally {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("构建清单如实列出部分与完整产物，并记录读取协议", async () => {
  const { writeCliManifest } = await import("../scripts/build-cli-light.mjs");
  const { CLI_FILES } = await import("../cloud/cli-release.mjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "page-review-manifest-"));
  const dir = path.join(root, "dist/cli/releases/0.4.4");
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "page-review-node.tar.gz"), "node fixture");
    const partial = await writeCliManifest(root);
    assert.deepEqual(partial.files, ["page-review-node.tar.gz"]);
    for (const name of CLI_FILES) await fs.writeFile(path.join(dir, name), "release fixture");
    const complete = await writeCliManifest(root);
    assert.equal(complete.version, "0.4.4");
    assert.equal(complete.readProtocol, 1);
    assert.deepEqual(complete.files, [...CLI_FILES]);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, "manifest.json"))), complete);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
