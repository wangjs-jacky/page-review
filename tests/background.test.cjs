const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm"),
  fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const Core = require("../extension/core.js");
function setup() {
  const records = new Map(),
    images = new Map(),
    local = { enabled: true },
    session = {},
    scripts = [];
  let handler, action, activated;
  const calls = { injected: 0, captured: 0 };
  const area = (source) => ({
    get: async (keys) =>
      typeof keys === "string"
        ? { [keys]: source[keys] }
        : Object.fromEntries(
            Object.entries(keys || {}).map(([key, value]) => [
              key,
              source[key] ?? value,
            ]),
          ),
    set: async (values) => Object.assign(source, values),
    remove: async (key) => {
      delete source[key];
    },
  });
  const DB = {
    list: async (page) =>
      [...records.values()].filter((note) => !page || note.pageId === page),
    get: async (id) => records.get(id),
    asset: async (id) => images.get(id),
    save: async (note, asset) => {
      records.set(note.id, structuredClone(note));
      if (asset) images.set(note.id, asset);
      return note;
    },
    remove: async (id) => {
      records.delete(id);
      images.delete(id);
    },
    patch: async (id, update) => {
      if (!records.has(id)) throw new Error("missing");
      const current = structuredClone(records.get(id)),
        changed = update(current);
      if (changed) records.set(id, structuredClone(changed));
      return changed || current;
    },
  };
  const chrome = {
    runtime: {
      id: "test",
      getURL: (name) => "chrome-extension://test/" + name,
      onMessage: {
        addListener: (value) => {
          handler = value;
        },
      },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
    },
    storage: { local: area(local), session: area(session) },
    permissions: {
      contains: async () => true,
      onRemoved: { addListener() {} },
    },
    scripting: {
      getRegisteredContentScripts: async () => scripts,
      registerContentScripts: async (items) => scripts.push(...items),
      unregisterContentScripts: async () => scripts.splice(0),
      executeScript: async () => {
        calls.injected++;
      },
    },
    action: {
      onClicked: {
        addListener: (value) => {
          action = value;
        },
      },
      setBadgeBackgroundColor: async () => {},
      setBadgeText: async () => {},
      setTitle: async () => {},
    },
    tabs: {
      onActivated: {
        addListener: (listener) => {
          activated = listener;
        },
      },
      get: async () => ({
        id: 1,
        windowId: 1,
        url: "https://example.com/read",
      }),
      query: async () => [{ id: 1 }],
      captureVisibleTab: async () => {
        calls.captured++;
        return "";
      },
      create: async () => ({ id: 2 }),
    },
  };
  const context = vm.createContext({
    PageReviewCloudConfig: {},
    PageReviewCore: Core,
    PageReviewDB: DB,
    PageReviewRecorder: { resume: async () => false },
    chrome,
    importScripts() {},
    console,
    URL,
    crypto,
    Date,
    Blob,
    btoa,
    atob,
    Uint8Array,
    Map,
    Promise,
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../extension/background.js"), "utf8"),
    context,
  );
  const page = {
      id: "test",
      frameId: 0,
      url: "https://example.com/read",
      tab: { id: 1 },
    },
    library = { id: "test", url: "chrome-extension://test/library.html" };
  return {
    records,
    images,
    local,
    chrome,
    calls,
    page,
    library,
    scripts,
    call: (type, payload = {}, sender = page) =>
      new Promise((resolve) => handler({ type, ...payload }, sender, resolve)),
    click: async () => {
      action({ id: 1, url: page.url });
      await vm.runInContext("actionQueue", context);
    },
    activate: async () => {
      activated({ tabId: 1 });
      await new Promise(setImmediate);
    },
  };
}
const sample = {
  url: "https://example.com/read",
  title: "文章",
  comment: "说明少一点，但来源要保留。",
  type: "element",
  label: "资料说明",
};
test("网页只能列出和读取本页数据，子frame和其他扩展请求被拒绝", async () => {
  const t = setup();
  t.records.set("one", { id: "one", pageId: sample.url });
  t.records.set("two", { id: "two", pageId: "https://another.example/" });
  assert.equal((await t.call("LIST")).value.length, 1);
  assert.equal((await t.call("LIST", {}, t.library)).value.length, 2);
  assert.equal((await t.call("GET_ASSET", { id: "two" })).ok, false);
  assert.equal((await t.call("LIST", {}, { ...t.page, frameId: 1 })).ok, false);
  assert.equal(
    (await t.call("LIST", {}, { ...t.page, id: "other" })).ok,
    false,
  );
});
test("缺截图不显示已完成；明确仅保存文字后才能入库；关闭时不能新增", async () => {
  const t = setup();
  assert.equal((await t.call("SAVE", { note: sample })).ok, false);
  assert.equal(t.records.size, 0);
  const result = await t.call("SAVE", {
    note: sample,
    allowWithoutImage: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.hasImage, false);
  t.local.enabled = false;
  assert.equal(
    (await t.call("SAVE", { note: sample, allowWithoutImage: true })).ok,
    false,
  );
  assert.equal(t.records.size, 1);
});
test("编辑保留历史画面、原话；拒绝过期revision，定位状态写回不覆盖新原话", async () => {
  const t = setup();
  const created = (
    await t.call("SAVE", { note: sample, allowWithoutImage: true })
  ).value;
  t.images.set(created.id, { viewport: "historic-image" });
  const edited = await t.call("SAVE", {
    note: { ...created, comment: "增加一句适用理由。" },
    revision: 1,
  });
  assert.equal(edited.ok, true);
  assert.equal(edited.value.originalComment, sample.comment);
  assert.equal(edited.value.history[0].comment, sample.comment);
  assert.equal(t.images.get(created.id).viewport, "historic-image");
  assert.equal(
    (
      await t.call("SAVE", {
        note: { ...created, comment: "过期覆盖" },
        revision: 1,
      })
    ).ok,
    false,
  );
  await t.call("LOCATION_RESULTS", {
    results: [{ id: created.id, status: "missing" }],
  });
  assert.equal(t.records.get(created.id).comment, "增加一句适用理由。");
  assert.equal(t.records.get(created.id).locationStatus, "missing");
});
test("不能从当前页写入、重绑或删除其他站点；本页可删除", async () => {
  const t = setup();
  assert.equal(
    (
      await t.call("SAVE", {
        note: { ...sample, url: "https://else.example/" },
        allowWithoutImage: true,
      })
    ).ok,
    false,
  );
  const created = (
    await t.call("SAVE", { note: sample, allowWithoutImage: true })
  ).value;
  t.records.set("other-note", {
    id: "other-note",
    pageId: "https://else.example/",
  });
  assert.equal((await t.call("DELETE", { id: "other-note" })).ok, false);
  assert.equal((await t.call("DELETE", { id: created.id })).ok, true);
  t.records.delete("other-note");
  t.records.set(created.id, created);
  assert.equal(
    (await t.call("DELETE", { id: created.id }, t.library)).ok,
    true,
  );
  assert.equal(t.records.size, 0);
});
test("反馈独立保存，修改保留原反馈历史和最初的空评论", async () => {
  const t = setup();
  const created = (
    await t.call("SAVE", {
      note: { ...sample, comment: "", feedback: "positive" },
      allowWithoutImage: true,
    })
  ).value;
  assert.equal(created.feedback, "positive");
  const edited = (
    await t.call("SAVE", {
      note: { ...created, comment: "补充原因", feedback: "negative" },
      revision: 1,
    })
  ).value;
  assert.equal(edited.feedback, "negative");
  assert.equal(edited.history[0].feedback, "positive");
  const cleared = (
    await t.call("SAVE", { note: { ...edited, feedback: null }, revision: 2 })
  ).value;
  assert.equal(cleared.feedback, null);
  assert.equal(cleared.originalComment, "");
  assert.equal(cleared.history[1].feedback, "negative");
});
test("截图前核对前台标签；不能误截另一个页面", async () => {
  const t = setup();
  t.chrome.tabs.query = async () => [{ id: 2 }];
  const response = await t.call("CAPTURE", {
    url: t.page.url,
    viewport: { width: 800, height: 600 },
  });
  assert.equal(response.ok, false);
  assert.equal(t.calls.captured, 0);
});
test("原生action处理器快速启用关闭；关闭不删除评注", async () => {
  const t = setup();
  const created = (
    await t.call("SAVE", { note: sample, allowWithoutImage: true })
  ).value;
  await t.click();
  assert.equal(t.local.enabled, false);
  assert(t.records.has(created.id));
  assert.equal(t.scripts.length, 0);
  await t.click();
  assert.equal(t.local.enabled, true);
  assert.equal(t.calls.injected, 1);
  assert.equal(t.scripts.length, 1);
  assert.equal(t.scripts[0].allFrames, false);
  await t.call("DISABLE");
  assert.equal(t.local.enabled, false);
  assert(t.records.has(created.id));
});
test("采纳/不采用及理由保存并保留原评注，网页脚本不能代改结果", async () => {
  const t = setup();
  const created = (
    await t.call("SAVE", { note: sample, allowWithoutImage: true })
  ).value;
  assert.equal(
    (
      await t.call("SET_OUTCOME", {
        id: created.id,
        status: "adopted",
        reason: "参考内容组织",
      })
    ).ok,
    false,
  );
  const result = await t.call(
    "SET_OUTCOME",
    { id: created.id, status: "rejected", reason: "保留必要辅助信息" },
    t.library,
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.comment, sample.comment);
  assert.equal(result.value.outcome.reason, "保留必要辅助信息");
});
test("启用后切换到已打开网页会补注入，关闭时不注入", async () => {
  const t = setup();
  await t.activate();
  assert.equal(t.calls.injected, 1);
  t.local.enabled = false;
  await t.activate();
  assert.equal(t.calls.injected, 1);
});
test("截图过程中切换前台标签会丢弃本次图像", async () => {
  const t = setup();
  let read = 0;
  t.chrome.tabs.query = async () => [{ id: ++read === 1 ? 1 : 2 }];
  const result = await t.call("CAPTURE", {
    url: t.page.url,
    viewport: { width: 800, height: 600 },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /截图期间页面已切换/);
  assert.equal(t.calls.captured, 1);
});

test("限制存储为可信上下文后，开关通过明确消息通知已有网页刷新", async () => {
  const t = setup(),
    notices = [];
  t.chrome.tabs.sendMessage = async (id, message) =>
    notices.push({ id, message });
  await t.click();
  await t.click();
  assert.equal(notices.length, 2);
  assert.equal(notices[0].id, 1);
  assert.equal(notices[0].message.type, "PAGE_REVIEW_SETTINGS_CHANGED");
});
