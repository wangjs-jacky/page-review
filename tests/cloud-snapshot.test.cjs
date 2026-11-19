const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { IDBFactory } = require("fake-indexeddb");

const origin = "https://cloud.example";
const workspace = "workspace-1";
const page = "https://example.com/one";
const otherPage = "https://example.com/two";
const picture = { viewport: "data:image/png;base64,AA==" };

function note(id, revision = 1, pageId = page) {
  return {
    id,
    pageId,
    url: pageId,
    revision,
    comment: "正文 " + revision,
    createdAt: "2026-11-19T00:00:00.000Z",
  };
}

function record(id, revision = 1, pageId = page) {
  return { id, revision, note: note(id, revision, pageId), assets: [] };
}

function client(indexedDB = new IDBFactory()) {
  const context = vm.createContext({
    indexedDB,
    crypto,
    AbortSignal,
    URLSearchParams,
    PageReviewCore: require("../extension/core.js"),
  });
  for (const file of ["db.js", "cloud.js"])
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../extension", file), "utf8"), context);
  const db = context.PageReviewDB;
  const connection = { apiUrl: origin, workspaceId: workspace, token: "test" };
  function createReader() {
    let connectionReads = 0;
    const expected = [];
    const api = context.PageReviewCloudFactory({
      db,
      apiOrigin: origin,
      storage: {
        get: async (key) => {
          if (key === "cloudConnection") connectionReads++;
          return { [key]: key === "cloudConnection" ? connection : null };
        },
      },
      fetcher: async (url) => {
        const request = expected.shift();
        assert.equal(url, origin + request.url);
        request.sent();
        return request.response;
      },
    });
    function startRefresh(target = page) {
      const sent = Promise.withResolvers();
      const response = Promise.withResolvers();
      expected.push({
        url: target === "library"
          ? "/v1/library?from=2026-11-01"
          : "/v1/pages?url=" + encodeURIComponent(target),
        sent: sent.resolve,
        response: response.promise,
      });
      const work = target === "library"
        ? api.refreshLibrary({ from: "2026-11-01" })
        : api.refreshPage(target);
      return {
        sent: Promise.race([sent.promise, work]),
        reply: (items) => {
          response.resolve(Response.json({ complete: true, items }));
          return work;
        },
      };
    }
    async function refresh(target) {
      const request = startRefresh(target);
      await request.sent;
      return request.reply;
    }
    return { startRefresh, refresh, connectionReads: () => connectionReads };
  }
  async function acknowledge(id, revision) {
    const entry = (await db.pending(workspace)).find((row) => row.id === id);
    assert.ok(entry);
    await db.acknowledge(entry, { revision, deleted: entry.kind === "delete" });
  }
  return { db, ...createReader(), parallelRefresh: createReader().refresh, acknowledge };
}

test("同一后台依次完成资料库和页面读回，后一次完整页应用新增与删除", async () => {
  const { db, startRefresh, connectionReads } = client();
  const first = startRefresh("library");
  await first.sent;
  const readsBefore = connectionReads();
  const second = startRefresh();
  const readsAfter = connectionReads();
  await first.reply([record("replaced")]);
  await second.reply([record("replacement")]);
  assert.equal(readsAfter, readsBefore);
  assert.equal(await db.get("replaced"), undefined);
  assert.equal((await db.get("replacement")).cloud.remoteRevision, 1);
});

test("晚返回的旧页面修订保留新修订及其附件缓存", async () => {
  const { db, refresh, parallelRefresh } = client();
  const older = await refresh();
  const newer = await parallelRefresh();
  await newer([record("updated", 2)]);
  await db.cacheAsset("updated", picture);
  await older([record("updated", 1)]);
  assert.equal((await db.get("updated")).cloud.remoteRevision, 2);
  assert.equal((await db.get("updated")).comment, "正文 2");
  assert.deepEqual(await db.asset("updated"), { ...picture, id: "updated" });
  await (await refresh())([record("updated", 1)]);
  assert.equal((await db.get("updated")).cloud.remoteRevision, 2);
});

test("旧空页保留请求期间确认的本机写入，新空页能删除记录与缓存", async () => {
  const { db, refresh, acknowledge } = client();
  const older = await refresh();
  await db.save(note("new-local"), picture, workspace);
  await acknowledge("new-local", 1);
  await older([]);
  assert.equal((await db.get("new-local")).cloud.status, "synced");
  assert.ok(await db.asset("new-local"));
  await (await refresh())([]);
  assert.equal(await db.get("new-local"), undefined);
  assert.equal(await db.asset("new-local"), undefined);
});

test("页面读回不会复活待删及请求期间已确认删除的评注", async () => {
  const { db, refresh, acknowledge } = client();
  await (await refresh())([record("to-delete")]);
  await db.remove("to-delete", workspace);
  await (await refresh())([record("to-delete")]);
  assert.equal(await db.get("to-delete"), undefined);
  assert.equal((await db.pending(workspace))[0].kind, "delete");
  const older = await refresh();
  await acknowledge("to-delete", 2);
  await older([record("to-delete")]);
  assert.equal(await db.get("to-delete"), undefined);
  assert.equal((await db.pending(workspace)).length, 0);
});

test("较早的资料库响应不会复活页面已确认不存在的评注，其他页面仍能导入", async () => {
  const { db, refresh, parallelRefresh } = client();
  const older = await refresh("library");
  await (await parallelRefresh())([]);
  await older([record("missing"), record("other", 1, otherPage)]);
  assert.equal(await db.get("missing"), undefined);
  assert.equal((await db.get("other")).pageId, otherPage);
  await (await refresh("library"))([record("first-import")]);
  assert.equal((await db.get("first-import")).cloud.status, "synced");
  assert.ok(await db.get("other"));
});

test("旧空页不会清除重叠读回导入的记录", async () => {
  const { db, refresh, parallelRefresh } = client();
  const newer = await refresh("library");
  const older = await parallelRefresh();
  await newer([record("new-remote")]);
  await older([]);
  assert.equal((await db.get("new-remote")).cloud.remoteRevision, 1);
});

test("资料库读回不会复活请求期间在本机确认删除的评注", async () => {
  const { db, refresh, acknowledge } = client();
  await (await refresh("library"))([record("deleted-local")]);
  const older = await refresh("library");
  await db.remove("deleted-local", workspace);
  await acknowledge("deleted-local", 2);
  await older([record("deleted-local")]);
  assert.equal(await db.get("deleted-local"), undefined);
  await (await refresh())([record("deleted-local")]);
  assert.equal(await db.get("deleted-local"), undefined);
});

test("重叠读回仍可安全应用已存在记录的更高云端修订", async () => {
  const { db, refresh, parallelRefresh } = client();
  const first = await refresh();
  const second = await parallelRefresh();
  await first([record("newer")]);
  await second([record("newer", 2)]);
  assert.equal((await db.get("newer")).cloud.remoteRevision, 2);
});

test("保留调到另一页的更新，已有记录不会被旧位置读回覆盖", async () => {
  const { db, refresh, parallelRefresh } = client();
  await (await refresh())([record("moved")]);
  const older = await refresh();
  await (await parallelRefresh(otherPage))([record("moved", 2, otherPage)]);
  assert.equal((await db.get("moved")).pageId, otherPage);
  await older([record("moved")]);
  assert.equal((await db.get("moved")).pageId, otherPage);
  assert.equal((await db.get("moved")).cloud.remoteRevision, 2);
});

test("从已有第三版 IndexedDB 更新后仍按新读回合并，旧版本可打开数据库", async () => {
  const indexedDB = new IDBFactory();
  const opened = indexedDB.open("page-review", 3);
  opened.onupgradeneeded = () => {
    const db = opened.result;
    const notes = db.createObjectStore("notes", { keyPath: "id" });
    notes.createIndex("byPage", "pageId");
    notes.put({
      ...note("legacy"),
      cloud: {
        workspaceId: workspace,
        remoteRevision: 1,
        syncedLocalRevision: 1,
        status: "synced",
      },
    });
    for (const store of ["assets", "outbox", "drafts"])
      db.createObjectStore(store, { keyPath: "id" });
  };
  const oldDatabase = await new Promise((resolve, reject) => {
    opened.onsuccess = () => resolve(opened.result);
    opened.onerror = () => reject(opened.error);
  });
  oldDatabase.close();
  const { db, refresh } = client(indexedDB);
  assert.equal((await db.get("legacy")).cloud.remoteRevision, 1);
  await (await refresh())([record("legacy", 2)]);
  assert.equal((await db.get("legacy")).cloud.remoteRevision, 2);
  assert.equal((await db.open()).version, 3);
  await (await refresh())([]);
  assert.equal(await db.get("legacy"), undefined);
});

test("录制草稿 API 与云同步元数据的键隔离", async () => {
  const { db, refresh } = client();
  await (await refresh())([]);
  const key = ["cloudSync", "clock", workspace];
  assert.equal(await db.draft(key), undefined);
  await db.deleteDraft(key);
  assert.equal(await db.refreshVersion(workspace), 1);
  await assert.rejects(db.putDraft({ id: key }), /草稿标识无效/);

  const draft = { id: "recording-draft", asset: picture };
  await db.putDraft(draft);
  assert.deepEqual(await db.draft(draft.id), draft);
  await db.deleteDraft(draft.id);
  assert.equal(await db.draft(draft.id), undefined);
});
