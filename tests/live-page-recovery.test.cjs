const { test } = require("node:test");
const assert = require("node:assert/strict");
const { setup } = require("./helpers/cloud.cjs");

test("旧数据缺映射时只读终端直接读取精确网页，不依赖拥有者刷新", async (t) => {
  const cloud = await setup(); t.after(() => cloud.sql.close());
  const { livePageId } = await import("../cloud/handoff.mjs");
  const reader = await cloud.reader();
  await cloud.save("target-note", { comment: "目标网页原话" });
  await cloud.save("same-domain-note", { pageId: "https://example.com/other", url: "https://example.com/other", comment: "同域名其他页面" });
  cloud.sql.exec("DELETE FROM live_pages");
  const id = await livePageId("workspace-1", cloud.note.pageId);
  const response = await cloud.request("/v1/handoffs/" + id, { token: reader.token });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.pageUrl, "https://example.com/guide");
  assert.deepEqual(data.records.map(n => n.comment), ["目标网页原话"]);
  assert.equal(cloud.sql.prepare("SELECT page_id FROM live_pages WHERE workspace_id=? AND id=?").get("workspace-1", id).page_id, "https://example.com/guide");
  assert.equal((await cloud.request("/v1/handoffs/" + id, { token: cloud.other })).status, 404);
});

test("旧数据恢复超过500个不同网页时返回明确回填需求，不假称标识不存在", async (t) => {
  const cloud = await setup(); t.after(() => cloud.sql.close());
  const { livePageId } = await import("../cloud/handoff.mjs");
  const reader = await cloud.reader();
  const insert = cloud.sql.prepare("INSERT INTO annotations(workspace_id,id,revision,body_json,search_text,domain,updated_at,mutation_id) VALUES(?,?,1,?,'','example.com',?,?)");
  for (let i = 0; i < 501; i++) {
    const url = "https://example.com/page-" + i;
    insert.run("workspace-1", "old-note-" + i, JSON.stringify({note:{...cloud.note,url,pageId:url},assets:[]}), "2026-11-20T00:00:00Z", "old-request-" + i);
  }
  const id = await livePageId("workspace-1", "https://example.com/page-500");
  const response = await cloud.request("/v1/handoffs/" + id, { token: reader.token });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "live_backfill_required");
  assert.equal(cloud.sql.prepare("SELECT COUNT(*) AS count FROM live_pages").get().count, 0);
});

test("live持久化迁移缺失时读取明确要求升级，而不是数据库500", async (t) => {
  const cloud = await setup(); t.after(() => cloud.sql.close());
  const { livePageId } = await import("../cloud/handoff.mjs");
  const reader = await cloud.reader();
  cloud.sql.exec("DROP TABLE live_page_saves; DROP TABLE live_pages;");
  const id = await livePageId("workspace-1", cloud.note.pageId);
  const response = await cloud.request("/v1/handoffs/" + id, { token: reader.token });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "live_upgrade_required");
});

test("旧网页恰为500个时仍可恢复目标编号，未知编号保持404", async (t) => {
  const cloud = await setup(); t.after(() => cloud.sql.close());
  const { livePageId } = await import("../cloud/handoff.mjs");
  const reader = await cloud.reader();
  await cloud.save("target-note", { comment: "500页边界目标" });
  const insert = cloud.sql.prepare("INSERT INTO annotations(workspace_id,id,revision,body_json,search_text,domain,updated_at,mutation_id) VALUES(?,?,1,?,'','example.com',?,?)");
  for (let i = 0; i < 499; i++) {
    const url = "https://example.com/page-" + i;
    insert.run("workspace-1", "old-note-" + i, JSON.stringify({note:{...cloud.note,url,pageId:url},assets:[]}), "2026-11-20T00:00:00Z", "old-request-" + i);
  }
  cloud.sql.exec("DELETE FROM live_pages");
  const id = await livePageId("workspace-1", cloud.note.pageId);
  const response = await cloud.request("/v1/handoffs/" + id, { token: reader.token });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).records.map(n => n.comment), ["500页边界目标"]);
  const missing = await livePageId("workspace-1", "https://example.com/not-saved");
  assert.equal((await cloud.request("/v1/handoffs/" + missing, {token: reader.token})).status, 404);
});

test("拥有者主动读取空页后固定编号可读0条，其他空间仍不可读", async (t) => {
  const cloud = await setup(); t.after(() => cloud.sql.close());
  const { livePageId } = await import("../cloud/handoff.mjs");
  const reader = await cloud.reader();
  const page = "https://example.com/empty";
  const id = await livePageId("workspace-1", page);
  const response = await cloud.request("/v1/pages?url=" + encodeURIComponent(page + "?utm_source=test#section"));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).items, []);
  const empty = await cloud.request("/v1/handoffs/" + id, {token: reader.token});
  assert.equal(empty.status, 200);
  const data = await empty.json();
  assert.equal(data.pageUrl, page);
  assert.deepEqual(data.records, []);
  assert.equal((await cloud.request("/v1/handoffs/" + id, {token: cloud.other})).status, 404);
  assert.equal((await cloud.request("/v1/pages?url=" + encodeURIComponent(page), {token: reader.token})).status, 403);
  assert.equal(cloud.sql.prepare("SELECT COUNT(*) AS count FROM annotations").get().count, 0);
});
