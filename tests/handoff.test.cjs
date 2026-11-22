const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  { setup, sha, png } = require("./helpers/cloud.cjs");
async function ready(t) {
  const reader = await t.reader();
  assert.equal(
    (
      await t.request("/v1/cli/confirm", {
        method: "POST",
        token: reader.token,
        data: { deviceName: "Test Mac" },
      })
    ).status,
    200,
  );
  return reader;
}
const create = (t) =>
  t.request("/v1/handoffs", {
    method: "POST",
    data: {
      pageUrl: "https://example.com/guide?utm_source=x#section",
      localRecords: [{ id: "annotation-1", revision: 1 }],
    },
  });
test("复制包含当前页全部历史；只读连接须经执行机器确认；旧修订不会随编辑变化", async () => {
  const t = await setup(),
    asset = await t.upload();
  await t.save("annotation-1", { hasImage: true }, 0, crypto.randomUUID(), [
    asset,
  ]);
  await t.save("historical-2", { comment: "从其他机器留下的历史" });
  assert.equal((await create(t)).status, 409);
  const r = await ready(t),
    created = await create(t);
  assert.equal(created.status, 201);
  const h = await created.json();
  assert.equal(h.count, 2);
  await t.save("annotation-1", { comment: "新文本" }, 1);
  const fixed = await (
    await t.request("/v1/handoffs/" + h.id, { token: r.token })
  ).json();
  assert.equal(
    fixed.records.find((n) => n.id === "annotation-1").comment,
    t.note.comment,
  );
  const a = fixed.records.find((n) => n.id === "annotation-1").assets[0];
  assert.equal((await t.request(a.path, { token: r.token })).status, 200);
  assert.equal(
    (await t.request("/v1/assets/" + asset.id, { token: r.token })).status,
    404,
  );
  assert.equal((await create(t)).status, 409);
  assert.equal(
    (await t.request("/v1/handoffs/" + h.id, { token: t.other })).status,
    404,
  );
});
test("删除和撤销阻止固定引用继续读取；未就绪附件不可生成交接", async () => {
  const t = await setup(),
    asset = await t.upload();
  await t.save("annotation-1", { hasImage: true }, 0, crypto.randomUUID(), [
    asset,
  ]);
  const r = await ready(t);
  t.env.FILES.head = async (key) => (t.objects.has(key) ? {} : null);
  const bytes = t.objects.get("workspace-1/" + asset.id);
  t.objects.clear();
  assert.equal((await create(t)).status, 409);
  t.objects.set("workspace-1/" + asset.id, bytes);
  const h = await (await create(t)).json();
  await t.request("/v1/annotations/annotation-1", {
    method: "DELETE",
    data: { expectedRevision: 1, requestId: crypto.randomUUID() },
  });
  assert.equal(
    (await t.request("/v1/handoffs/" + h.id, { token: r.token })).status,
    410,
  );
  assert.equal(
    (
      await t.request(`/v1/handoffs/${h.id}/assets/${asset.id}`, {
        token: r.token,
      })
    ).status,
    410,
  );
  await t.request("/v1/connections/" + r.id, { method: "DELETE" });
  assert.equal(
    (await t.request("/v1/handoffs/" + h.id, { token: r.token })).status,
    401,
  );
});
test("录制必须有视频、封面和对应关键帧；视频不能冒充图片；reader确认不开放其他写入", async () => {
  const t = await setup(),
    r = await ready(t);
  assert.equal(
    (
      await t.request("/v1/annotations/annotation-1", {
        method: "PUT",
        token: r.token,
        data: {},
      })
    ).status,
    403,
  );
  const bytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6]),
    id = sha(bytes);
  assert.equal(
    (
      await t.request("/v1/uploads/" + id, {
        method: "PUT",
        raw: bytes,
        contentType: "video/webm",
      })
    ).status,
    200,
  );
  const image = await t.upload(),
    video = { id, role: "video", width: 320, height: 180 },
    recording = { duration: 2, frames: [{ at: 1, role: "frame-0" }] };
  assert.equal(
    (
      await t.save(
        "annotation-1",
        { hasImage: true, hasVideo: true, mediaType: "video", recording },
        0,
        crypto.randomUUID(),
        [image, video],
      )
    ).status,
    400,
  );
  const frame = { ...image, role: "frame-0" };
  assert.equal(
    (
      await t.save(
        "annotation-1",
        { hasImage: true, hasVideo: true, mediaType: "video", recording },
        0,
        crypto.randomUUID(),
        [image, video, frame],
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await t.save("annotation-2", { hasImage: true }, 0, crypto.randomUUID(), [
        { ...video, role: "viewport" },
      ])
    ).status,
    400,
  );
});

test("未变快照并发复制共用同一引用，允许反复读取，修改后生成新引用", async () => {
  const t = await setup();
  const r = await ready(t);
  await t.save("annotation-1");
  const copies = await Promise.all([create(t), create(t), create(t)]);
  assert.deepEqual(copies.map((response) => response.status).sort(), [200, 200, 201]);
  const refs = await Promise.all(copies.map((response) => response.json()));
  assert.deepEqual(refs, [refs[0], refs[0], refs[0]]);
  for (let read = 0; read < 2; read++) {
    const response = await t.request("/v1/handoffs/" + refs[0].id, { token: r.token });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).records[0].comment, t.note.comment);
  }
  await t.save("annotation-1", { comment: "修改后的评注" }, 1);
  const next = await t.request("/v1/handoffs", {
    method: "POST",
    data: { pageUrl: t.note.pageId, localRecords: [{ id: "annotation-1", revision: 2 }] },
  });
  assert.equal(next.status, 201);
  const { id } = await next.json();
  assert.notEqual(id, refs[0].id);
  assert.equal((await t.request("/v1/handoffs/" + refs[0].id, { token: r.token })).status, 200);
});

test("固定网页编号支持旧数据登记和删除最后一条，同名页面跨工作区不可读", async () => {
  const t = await setup(), r = await ready(t);
  const { livePageId } = await import("../cloud/handoff.mjs");
  const page = t.note.pageId;
  const route = "/v1/handoffs/" + await livePageId("workspace-1", page);
  assert.equal((await t.save()).status, 200);
  t.sql.prepare("DELETE FROM live_pages WHERE workspace_id=?").run("workspace-1");
  // The existing reader resolves legacy page mappings without a writer refresh.
  assert.equal((await t.request(route, { token: r.token })).status, 200);
  assert.equal((await t.request(route, { token: t.other })).status, 404);
  const marker = crypto.randomUUID();
  const gone = await t.request("/v1/annotations/annotation-1", {
    method: "DELETE",
    data: { expectedRevision: 1, requestId: crypto.randomUUID(), syncMarkers: [marker], pageUrl: page },
  });
  assert.equal(gone.status, 200);
  const latest = await t.request(route + "?after=" + marker, { token: r.token });
  assert.equal(latest.status, 200);
  assert.deepEqual((await latest.json()).records, []);
});
