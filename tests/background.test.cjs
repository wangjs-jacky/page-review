const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm"),
  fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const Core = require("../extension/core.js");
function setup({ cloud, recorder } = {}) {
  const records = new Map(),
    images = new Map(),
    local = { enabled: true },
    session = {},
    scripts = [];
  let handler, action, activated, permissionRemoved, installed;
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
      onInstalled: { addListener: (listener) => { installed = listener; } },
      onStartup: { addListener() {} },
    },
    storage: { local: area(local), session: area(session) },
    permissions: {
      contains: async () => true,
      onRemoved: { addListener(listener) { permissionRemoved = listener; } },
    },
    scripting: {
      getRegisteredContentScripts: async () => scripts,
      registerContentScripts: async (items) => scripts.push(...items),
      updateContentScripts: async (items) => scripts.splice(0, scripts.length, ...items),
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
    ...(cloud ? { PageReviewCloudFactory: () => cloud } : {}),
    PageReviewDB: DB,
    PageReviewRecorder: { resume: async () => false, disable: async () => {}, enable() {}, ...recorder },
    chrome,
    importScripts() {},
    console,
    URL,
    crypto,
    Date,
    Blob,
    createImageBitmap: async () => ({ width: 800, height: 600, close() {} }),
    OffscreenCanvas: class {
      getContext() {
        return { drawImage() {}, strokeRect() {} };
      }
      async convertToBlob({ type }) {
        return new Blob(["synthetic image"], { type });
      }
    },
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
    removePermission: async () => {
      permissionRemoved();
      await vm.runInContext("registrationQueue", context);
    },
    activate: async () => {
      activated({ tabId: 1 });
      await new Promise(setImmediate);
    },
    install: async () => {
      installed();
      await vm.runInContext("registrationQueue", context);
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
test("私有面板凭据仅绑定一次，并且只交给本标签的扩展子文档", async () => {
  const t = setup();
  const frame = { ...t.page, frameId: 2, url: t.chrome.runtime.getURL("panel.html") };
  assert.equal((await t.call("PANEL_AUTHORIZE", { channel: crypto.randomUUID() }, frame)).ok, false);
  assert.equal((await t.call("PANEL_BIND", {}, { ...t.page, frameId: 2 })).ok, false);
  const binding = await t.call("PANEL_BIND");
  assert.equal(binding.ok, true);
  const channel = binding.value;
  assert.equal((await t.call("PANEL_AUTHORIZE", { channel }, { ...frame, frameId: 0 })).ok, false);
  assert.equal((await t.call("PANEL_AUTHORIZE", { channel }, { ...frame, tab: { id: 2 } })).ok, false);
  assert.equal((await t.call("PANEL_AUTHORIZE", { channel: crypto.randomUUID() }, frame)).ok, false);
  assert.equal((await t.call("PANEL_AUTHORIZE", { channel }, frame)).ok, true);
  assert.equal((await t.call("PANEL_AUTHORIZE", { channel }, frame)).ok, false);
});
test("升级后替换原来已启用的内容脚本注册", async () => {
  const t = setup();
  t.scripts.push({
    id: "page-review-pages",
    js: ["core.js", "media.js", "content-style.js", "content.js"],
    matches: ["http://*/*", "https://*/*"],
  });
  await t.install();
  assert.equal(t.scripts.length, 1);
  assert.equal(t.scripts[0].js.at(-2), "private-panel.js");
  assert.equal(t.scripts[0].js.at(-1), "content.js");
});
test("保存先落盘并响应，再由保存事件自动上传；失败不影响本地记录", async () => {
  const uploads = [];
  const t = setup({ cloud: {
    workspace: async () => "workspace-1",
    sync: async (options) => { uploads.push(options); throw Error("offline"); },
  } });
  const saved = await t.call("SAVE", { note: sample, allowWithoutImage: true });
  assert.equal(saved.ok, true);
  assert.equal(t.records.get(saved.value.id).comment, sample.comment);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].page, sample.url);
});
test("修改和删除拒绝其他账号记录，原记录不变且不触发上传", async () => {
  let uploads = 0;
  const t = setup({ cloud: {
    workspace: async () => "workspace-2", sync: async () => { uploads++; },
  } });
  const existing = { ...sample, id: "foreign-note", pageId: sample.url, revision: 1,
    cloud: { workspaceId: "workspace-1" } };
  t.records.set(existing.id, existing);
  const edit = await t.call("SAVE", { note: { ...existing, comment: "新文字" }, revision: 1 });
  const deletion = await t.call("DELETE", { id: existing.id });
  assert.equal(edit.code, "account_mismatch");
  assert.equal(deletion.code, "account_mismatch");
  assert.equal(t.records.get(existing.id).comment, sample.comment);
  assert.equal(uploads, 0);
});
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
test("没有修订号的旧评注仍可编辑并删除", async () => {
  const t = setup();
  const saved = (await t.call("SAVE", { note: sample, allowWithoutImage: true })).value;
  delete t.records.get(saved.id).revision;

  const edited = await t.call("SAVE", { note: { ...saved, comment: "修订旧评注" } });
  assert.equal(edited.ok, true);
  assert.equal(edited.value.revision, 1);
  assert.equal(edited.value.originalComment, sample.comment);
  assert.equal((await t.call("DELETE", { id: saved.id })).ok, true);
  assert.equal(t.records.has(saved.id), false);
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
test("单页应用切换路由后，区域截图可保存并归入当前网页", async () => {
  const t = setup();
  const url = "https://example.com/chat/%2Fworkspace?view=review#/notes";
  const tab = { id: 1, windowId: 1, url };
  const sender = { ...t.page, tab };
  t.chrome.tabs.get = async () => tab;
  t.chrome.tabs.captureVisibleTab = async () => "data:image/png;base64,AA==";
  const captured = await t.call("CAPTURE", {
    url,
    noteType: "region",
    viewport: { width: 800, height: 600 },
    rect: { left: 40, top: 50, width: 120, height: 75 },
  }, sender);
  assert.equal(captured.ok, true, captured.error);
  assert.equal(captured.value.cropWidth, 120);
  assert.equal(captured.value.cropHeight, 75);
  const saved = await t.call("SAVE", {
    note: { ...sample, url, type: "region" },
    asset: captured.value,
  }, sender);
  assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.value.pageId, url);
  assert.equal(saved.value.hasImage, true);
  assert.equal((await t.call("LIST", {}, sender)).value[0].id, saved.value.id);
  assert.equal((await t.call("LIST")).value.length, 0);
});
test("过期选区、跨站消息和非活动文档都不会发起截图", async () => {
  const t = setup();
  const url = "https://example.com/other-route";
  const tab = { id: 1, windowId: 1, url };
  t.chrome.tabs.get = async () => tab;
  const viewport = { width: 800, height: 600 };
  const stale = await t.call("CAPTURE", { url: t.page.url, viewport }, { ...t.page, tab });
  assert.equal(stale.ok, false);
  const crossOrigin = { ...t.page, url: "https://other.example/", tab };
  assert.equal((await t.call("CAPTURE", { url, viewport }, crossOrigin)).ok, false);
  assert.equal((await t.call("LIST", {}, crossOrigin)).ok, false);
  const cached = { ...t.page, url, tab, documentLifecycle: "cached" };
  assert.equal((await t.call("CAPTURE", { url, viewport }, cached)).ok, false);
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

test("截图过程中同一标签切换路由会丢弃本次图像", async () => {
  const t = setup();
  let url = t.page.url;
  t.chrome.tabs.get = async () => ({ id: 1, windowId: 1, url });
  t.chrome.tabs.captureVisibleTab = async () => {
    url = "https://example.com/other-route";
    return "data:image/png;base64,AA==";
  };
  const result = await t.call("CAPTURE", {
    url: t.page.url,
    viewport: { width: 800, height: 600 },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /截图期间页面已切换/);
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

test('资料库真实标签删除后仍触发同步，不把扩展URL当作网页处理', async () => {
  const syncCalls = [];
  const t = setup({ cloud: {
    workspace: async () => undefined,
    sync: async (options) => { syncCalls.push(options); },
  } });
  t.records.set('ego-cleanup-note', { id: 'ego-cleanup-note', pageId: t.page.url, url: t.page.url });
  const result = await t.call('DELETE', { id: 'ego-cleanup-note' }, { ...t.library, tab: { id: 2 } });
  await new Promise(setImmediate);
  assert.equal(result.ok, true);
  assert.equal(t.records.has('ego-cleanup-note'), false);
  assert.equal(syncCalls.length, 1);
  assert.equal(syncCalls[0], undefined);
});


test("网页关闭、工具栏关闭和站点权限移除会停止录制", async () => {
  for (const disable of [
    async t => { assert.equal((await t.call("DISABLE")).ok, true); },
    async t => t.click(),
    async t => { t.chrome.permissions.contains = async () => false; await t.removePermission(); },
  ]) {
    let active = true;
    const t = setup({ recorder: { disable: async () => { active = false; } } });
    await disable(t);
    assert.equal(active, false);
    assert.equal(t.local.enabled, false);
  }
});

test("工具关闭后允许网页清理录制，保存库无法调用网页录制", async () => {
  const commands = [];
  const t = setup({ recorder: { command: async (message, sender) => {
    commands.push([message.type, sender.url]);
    return true;
  } } });
  t.local.enabled = false;
  assert.equal((await t.call("RECORD_STOP")).ok, true);
  assert.equal((await t.call("RECORD_CANCEL")).ok, true);
  assert.equal((await t.call("RECORD_CANCEL", {}, t.library)).ok, false);
  assert.deepEqual(commands, [["RECORD_STOP", t.page.url], ["RECORD_CANCEL", t.page.url]]);
});

test("工具栏重新启用时不恢复原先等待授权的选区", async () => {
  let attempted = false;
  const t = setup({ recorder: { resume: async () => { attempted = true; return true; } } });
  t.local.enabled = false;
  await t.click();
  assert.equal(attempted, false);
  assert.equal(t.local.enabled, true);
});


test("停用在原生录制清理完成后才写入关闭状态", async () => {
  let finish;
  const cleanup = new Promise(resolve => { finish = resolve; });
  const t = setup({ recorder: { disable: () => cleanup } });
  const disabled = t.call("DISABLE");
  await new Promise(setImmediate);
  assert.equal(t.local.enabled, true);
  finish();
  assert.equal((await disabled).ok, true);
  assert.equal(t.local.enabled, false);
});
