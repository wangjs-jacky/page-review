const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm"), fs = require("node:fs"), path = require("node:path");
const crypto = require("node:crypto");
const { setup, png } = require("./helpers/cloud.cjs");
async function client({ readProtocol = 1 } = {}) {
  const server = await setup(), reader = await server.reader();
  await server.request("/v1/cli/confirm", {
    method: "POST", token: reader.token,
    data: { deviceName: "Test Mac", readProtocol, clientVersion: readProtocol ? "0.4.4" : "0.4.3" },
  });
  const notes = new Map(), images = new Map(), rows = new Map(), calls = [];
  const data = { cloudConnection: {
    apiUrl: "https://cloud.example", workspaceId: "workspace-1", token: server.writer,
  } };
  const db = {
    list: async (page) => structuredClone([...notes.values()].filter(n => !page || n.pageId === page)),
    pending: async (workspace) => structuredClone([...rows.values()].filter(n => !workspace || n.workspaceId === workspace)),
    asset: async (id) => images.get(id),
    patch: async (id, update, workspaceId) => {
      const n = update(structuredClone(notes.get(id)));
      if (n.cloud?.workspaceId && n.cloud.workspaceId !== workspaceId)
        throw Error("account changed");
      n.cloud = { ...n.cloud, workspaceId, status: "pending", remoteRevision: n.cloud?.remoteRevision || 0 };
      notes.set(id, n);
      rows.set(id, { id, note: n, kind: "upsert", requestId: crypto.randomUUID(),
        workspaceId, localRevision: n.revision, remoteRevision: n.cloud.remoteRevision });
    },
    acknowledge: async (entry, remote) => {
      if (rows.get(entry.id)?.requestId === entry.requestId) rows.delete(entry.id);
      const n = notes.get(entry.id);
      n.cloud = { ...n.cloud, status: "synced", remoteRevision: remote.revision,
        syncedLocalRevision: entry.localRevision };
    },
    markFailure: async (entry, error) => { rows.get(entry.id).error = error.message; },
    refreshVersion: async () => 0,
    importPage: async () => {},
  };
  let failUpload = 0;
  const serviceCapabilities = { livePageReferences: 1, cliAvailable: true };
  const context = vm.createContext({ crypto, AbortSignal, URL, TextEncoder, Uint8Array,
    DataView, atob, btoa, PageReviewCore: require("../extension/core.js") });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../extension/cloud.js"), "utf8"), context);
  const api = context.PageReviewCloudFactory({ db, apiOrigin: "https://cloud.example",
    storage: { get: async key => ({ [key]: data[key] }), set: async v => Object.assign(data, v) },
    fetcher: async (url, options = {}) => {
      const u = new URL(url); calls.push({ path: u.pathname, ...options });
      if (u.pathname === "/v1/capabilities")
        return Response.json(serviceCapabilities);
      if (u.pathname.startsWith("/v1/uploads/") && failUpload-- > 0)
        throw Error("offline");
      return server.request(u.pathname + u.search, {
        method: options.method, token: options.headers.Authorization.slice(7),
        ...(options.headers["Content-Type"] === "application/json" || options.headers["content-type"] === "application/json"
          ? { data: JSON.parse(options.body) }
          : { raw: options.body, contentType: options.headers["Content-Type"] }),
      });
    },
  });
  const add = (id, changes = {}, image) => {
    notes.set(id, { ...server.note, id, revision: 1, ...changes });
    if (image) images.set(id, image);
  };
  return { server, reader, api, add, notes, rows, calls, data, serviceCapabilities,
    failUpload: n => { failUpload = n; } };
}
test("复制直接补齐未入队的当前页截图和区域录制，终端读回原话与全部附件", async () => {
  const t = await client(), image = "data:image/png;base64," + png.toString("base64");
  const video = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6]);
  t.add("screenshot-1", { hasImage: true, comment: "截图原话" }, { viewport: image, crop: image, width: 1, height: 1 });
  t.add("recording-1", { hasImage: true, hasVideo: true, mediaType: "video", comment: "区域录制原话",
    recording: { duration: 2, frames: [{ at: 1, role: "frame-0" }] } },
    { viewport: image, video: "data:video/webm;base64," + video.toString("base64"),
      frames: [{ at: 1, data: image }], width: 320, height: 180 });
  t.add("other-page", { pageId: "https://example.com/other", url: "https://example.com/other" });
  const handoff = await t.api.handoff(t.server.note.pageId);
  assert.equal(handoff.count, 2);
  assert.equal(t.notes.get("other-page").cloud, undefined);
  const read = await t.server.request("/v1/handoffs/" + handoff.id, { token: t.reader.token });
  assert.equal(read.status, 200);
  const fixed = await read.json();
  assert.deepEqual(fixed.records.map(n => n.comment).sort(), ["区域录制原话", "截图原话"].sort());
  assert.equal(fixed.records.flatMap(n => n.assets).length, 5);
  for (const asset of fixed.records.flatMap(n => n.assets)) {
    const response = await t.server.request(asset.path, { token: t.reader.token });
    assert.equal(response.status, 200);
    assert.equal(crypto.createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex"), asset.id);
  }
});

test("旧服务不能复制一个终端无法读取的网页引用", async () => {
  const t = await client();
  t.add("saved-note", { cloud: { workspaceId: "workspace-1", status: "synced" } });
  delete t.serviceCapabilities.livePageReferences;
  await assert.rejects(t.api.pageReference(t.server.note.pageId),
    e => e.code === "service_update_required");
  assert(!t.calls.some(c => c.method && c.method !== "GET"));
});

test("旧终端确认不能满足带同步门禁的网页引用读取", async () => {
  const t = await client({ readProtocol: 0 });
  t.add("saved-note", { cloud: { workspaceId: "workspace-1", status: "synced" } });
  await assert.rejects(t.api.pageReference(t.server.note.pageId),
    e => e.code === "cli_update_required");
  assert(!t.calls.some(c => c.method && c.method !== "GET"));
});

test("过期或要求重新认证的连接不能离线声称复制成功", async () => {
  for (const change of [{ authenticationRequired: true }, { expiresAt: "2020-01-01T00:00:00Z" }]) {
    const t = await client();
    Object.assign(t.data.cloudConnection, change);
    t.add("saved-note", { cloud: { workspaceId: "workspace-1", status: "synced" } });
    await assert.rejects(t.api.pageReference(t.server.note.pageId),
      e => e.code === "login_required");
    assert.equal(t.calls.length, 0);
  }
});

test("空页复制明确登记目标网页，终端读取零条而非复制成功后404", async () => {
  const t = await client(), page = t.server.note.pageId;
  const copied = await t.api.pageReference(page);
  assert.equal(copied.pending, false);
  const id = copied.reference.slice("page-review-".length);
  const read = await t.server.request("/v1/handoffs/" + id, { token: t.reader.token });
  assert.equal(read.status, 200);
  const context = await read.json();
  assert.equal(context.pageUrl, page);
  assert.deepEqual(context.records, []);
  assert.equal(t.calls.filter(c => c.path === "/v1/pages").length, 1);
  assert.equal(t.server.sql.prepare("SELECT COUNT(*) AS count FROM annotations").get().count, 0);
});
test("当前页超过100条待传时单次完整复制，不受其他页面队列影响", async () => {
  const t = await client();
  t.rows.set("other-pending", { id: "other-pending", workspaceId: "workspace-1",
    kind: "upsert", note: { pageId: "https://example.com/other", hasImage: true } });
  for (let i = 0; i < 105; i++) t.add("annotation-saved-" + i);
  const h = await t.api.handoff(t.server.note.pageId);
  assert.equal(h.count, 105);
  assert.equal(t.rows.size, 1);
  assert(t.rows.has("other-pending"));
  assert.equal(t.calls.filter(c => c.path.startsWith("/v1/annotations/")).length, 105);
});
test("附件上传失败不生成引用，原处再次复制复用请求ID并包含完整附件", async () => {
  const t = await client();
  t.add("annotation-retry-1", { hasImage: true }, { viewport: "data:image/png;base64," + png.toString("base64"), width: 1, height: 1 });
  t.failUpload(1);
  await assert.rejects(t.api.handoff(t.server.note.pageId), /offline/);
  assert(!t.calls.some(c => c.path === "/v1/handoffs"));
  const requestId = t.rows.get("annotation-retry-1").requestId;
  const h = await t.api.handoff(t.server.note.pageId);
  assert.equal(h.count, 1);
  const write = t.calls.find(c => c.path === "/v1/annotations/annotation-retry-1");
  assert.equal(JSON.parse(write.body).requestId, requestId);
  assert.equal(JSON.parse(write.body).assets.length, 1);
});
test("未登录和账号不一致给出明确操作码，不上传、不改归属、不产生部分复制", async () => {
  const t = await client();
  t.add("local-1");
  const connection = t.data.cloudConnection;
  t.data.cloudConnection = null;
  await assert.rejects(t.api.handoff(t.server.note.pageId), e => e.code === "login_required");
  t.data.cloudConnection = connection;
  t.add("foreign-1", { cloud: { workspaceId: "workspace-2" } });
  await assert.rejects(t.api.handoff(t.server.note.pageId), e => e.code === "account_mismatch");
  assert.equal(t.calls.length, 0);
  assert.equal(t.notes.get("local-1").cloud, undefined);
  assert.equal(t.notes.get("foreign-1").cloud.workspaceId, "workspace-2");
});
test("缺失本地附件时不能静默降级为仅文字复制", async () => {
  const t = await client();
  t.add("missing-1", { hasImage: true });
  await assert.rejects(t.api.handoff(t.server.note.pageId), e => e.code === "asset_unavailable");
  assert.equal(t.calls.length, 0);
});
test("上传时会话失效转为登录操作，保留待传记录且不生成引用", async () => {
  const t = await client();
  t.add("expired-session-note");
  await t.server.request("/v1/session", { method: "DELETE" });
  await assert.rejects(t.api.handoff(t.server.note.pageId), e => e.code === "login_required");
  assert.equal(t.rows.size, 1);
  assert.equal((await t.api.status()).configured, false);
  assert(!t.calls.some(c => c.path === "/v1/handoffs"));
});
test("快速复制保留完整云端快照，远端修订变化时刷新一次且允许原处重试", async () => {
  const t = await client(); t.add("annotation-stale-1", {comment:"初稿"});
  await t.api.handoff(t.server.note.pageId);
  assert.equal(t.calls.filter(c=>c.path==='/v1/pages').length,0);
  const changed=await t.server.save("annotation-stale-1",{comment:"另一端的新原话"},1);
  assert.equal(changed.status,200);
  await assert.rejects(t.api.handoff(t.server.note.pageId),e=>e.code==='page_changed');
  assert.equal(t.calls.filter(c=>c.path==='/v1/pages').length,1);
  // This test's importPage stub does not mutate IndexedDB; model the completed import.
  t.notes.get('annotation-stale-1').cloud.remoteRevision=2;
  const again=await t.api.handoff(t.server.note.pageId);
  const read=await t.server.request('/v1/handoffs/'+again.id,{token:t.reader.token});
  assert.equal((await read.json()).records[0].comment,'另一端的新原话');
  assert.equal(t.calls.filter(c=>c.path==='/v1/pages').length,1);
});

test("复制只检查协议就绪，带同步标记的读取在截图齐全前失败，随后读到最新附件", async () => {
  const t = await client();
  const page = t.server.note.pageId;
  const image = "data:image/png;base64," + png.toString("base64");
  t.add("live-screenshot", { hasImage: true }, { viewport: image, width: 1, height: 1 });
  // Emulate the persisted save event. The uploader remains offline until explicitly retried.
  const original = t.notes.get("live-screenshot");
  const marker = crypto.randomUUID();
  const note = { ...original, comment: "刚保存的新截图", revision: 2, hasImage: true,
    cloud: { workspaceId: "workspace-1", remoteRevision: 0, status: "pending" } };
  t.notes.set(note.id, note);
  t.rows.set(note.id, { id: note.id, requestId: marker, syncMarkers: [marker],
    workspaceId: "workspace-1", kind: "upsert", remoteRevision: 0, localRevision: 2, note });
  t.failUpload(1);
  await t.api.sync({ page });
  const beforeCopy = t.calls.length;
  const copied = await t.api.pageReference(page);
  assert.deepEqual(t.calls.slice(beforeCopy).map(call => call.path).sort(),
    ["/v1/capabilities", "/v1/cli/connections"]);
  const [reference, requirement] = copied.reference.split("\n");
  assert.match(reference, /^page-review-live-[a-f0-9]{64}$/);
  assert(copied.text.includes("page-review read " + reference + " --after " + marker));
  assert.equal(requirement, "同步要求：--after " + marker);
  const read = "/v1/handoffs/" + reference.slice("page-review-".length);
  const waiting = await t.server.request(read + "?after=" + marker, { token: t.reader.token });
  assert.equal(waiting.status, 409);
  assert.equal((await waiting.json()).code, "sync_pending");
  await t.api.sync({ page });
  const afterSync = t.calls.length;
  assert.equal((await t.api.pageReference(page)).reference, reference);
  assert.deepEqual(t.calls.slice(afterSync).map(call => call.path).sort(),
    ["/v1/capabilities", "/v1/cli/connections"]);
  const complete = await t.server.request(read + "?after=" + marker, { token: t.reader.token });
  assert.equal(complete.status, 200);
  const [record] = (await complete.json()).records;
  assert.equal(record.comment, "刚保存的新截图");
  assert.equal(record.assets.length, 1);
  const response = await t.server.request(record.assets[0].path, { token: t.reader.token });
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  assert.equal((await t.server.request(read, { token: t.server.other })).status, 404);
});
