const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  vm = require("node:vm"),
  fs = require("node:fs"),
  path = require("node:path"),
  Media = require("../extension/media.js");
function setup() {
  const session = {},
    messages = [],
    tabMessages = [];
  let deny = false,
    contexts = [],
    enabled = true,
    closeOffscreen = async () => {},
    cancelOffscreen = async () => ({ cancelled: true }),
    capture = async () => "test-stream",
    startOffscreen = async () => ({ recording: true }),
    stopResult = { draftId: "saved-draft" },
    closed = 0,
    lookup = async () => tab;
  const tab = { id: 1, url: "https://example.com/guide" },
    chrome = {
      runtime: {
        id: "test",
        getURL: (name) => "chrome-extension://test/" + name,
        getContexts: async () => contexts,
        sendMessage: async (m) => {
          messages.push(m);
          return {
            ok: true,
            value:
              m.command === "STOP"
                ? stopResult
                : m.command === "START"
                  ? await startOffscreen()
                  : m.command === "CANCEL"
                    ? await cancelOffscreen()
                    : { copied: true },
          };
        },
      },
      storage: {
        local: { get: async () => ({ enabled }) },
        session: {
          get: async (key) => ({ [key]: session[key] }),
          set: async (value) => Object.assign(session, value),
          remove: async (key) => delete session[key],
        },
      },
      offscreen: {
        createDocument: async (options) => {
          assert(options.reasons.includes("USER_MEDIA"));
          assert(options.reasons.includes("CLIPBOARD"));
          contexts = [{}];
        },
        closeDocument: async () => {
          closed++;
          await closeOffscreen();
          contexts = [];
        },
      },
      tabCapture: {
        getMediaStreamId: async () => {
          if (deny) throw Error("requires invocation");
          return capture();
        },
      },
      tabs: {
        get: () => lookup(),
        sendMessage: async (_id, message) => { tabMessages.push(message); },
        onRemoved: { addListener() {} },
        onUpdated: { addListener() {} },
      },
    };
  const context = vm.createContext({
    chrome,
    PageReviewMedia: Media,
    Date,
    crypto: require("node:crypto"),
    console,
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../extension/recorder.js"), "utf8"),
    context,
  );
  return {
    api: context.PageReviewRecorder,
    tab,
    messages,
    tabMessages,
    lookup: (fn) => (lookup = fn),
    enabled: (v) => (enabled = v),
    closeOffscreen: (fn) => (closeOffscreen = fn),
    cancelOffscreen: (fn) => (cancelOffscreen = fn),
    capture: (fn) => (capture = fn),
    startOffscreen: (fn) => (startOffscreen = fn),
    deny: (v) => (deny = v),
    stop: (v) => (stopResult = v),
    closed: () => closed,
  };
}
const message = {
    type: "RECORD_START",
    url: "https://example.com/guide",
    rect: { left: 100, top: 150, width: 320, height: 180 },
    viewport: { width: 1000, height: 700 },
  },
  sender = { tab: { id: 1 }, url: message.url };
test("原生调用未授权时等待工具栏确认；取消清除会话，其他网页不能停止录制", async () => {
  const t = setup();
  t.deny(true);
  assert.equal((await t.api.command(message, sender)).needsToolbar, true);
  assert.equal(t.messages.length, 0);
  assert.equal((await t.api.get()).pending, true);
  await t.api.command({ type: "RECORD_CANCEL" }, sender);
  assert.equal(await t.api.get(), undefined);
  t.deny(false);
  await t.api.command(message, sender);
  await assert.rejects(
    t.api.command(
      { type: "RECORD_STOP" },
      { ...sender, url: "https://other.example/" },
    ),
  );
  await t.api.command({ type: "RECORD_CANCEL" }, sender);
  assert.equal(await t.api.get(), undefined);
});
test("使用Chrome116起的getContexts，不依赖较新的hasDocument；丢失offscreen采集可重试而不永久锁死", async () => {
  const t = setup();
  await t.api.command(message, sender);
  assert.equal((await t.api.get()).pending, false);
  t.stop(undefined);
  t.cancelOffscreen(async () => { throw Error("offscreen closed"); });
  await assert.rejects(
    t.api.command({ type: "RECORD_STOP" }, sender),
    /录制已中断/,
  );
  assert.equal(await t.api.get(), undefined);
  assert.equal(t.closed(), 1);
  t.cancelOffscreen(async () => ({ cancelled: true }));
  t.stop({ draftId: "second-draft" });
  await t.api.command(message, sender);
  assert.equal(
    (await t.api.command({ type: "RECORD_STOP" }, sender)).draftId,
    "second-draft",
  );
  await t.api.event({ event: "STOPPED", tabId: 1, pageUrl: message.url,
    sessionId: t.messages.at(-1).sessionId });
  assert.equal(await t.api.get(), undefined);
  await t.api.copy("page-review read reference-id");
  assert.equal(t.messages.at(-1).command, "COPY");
});


test("停用清理待工具栏授权的会话，重新启用后只接受新选区", async () => {
  const t = setup();
  t.deny(true);
  assert.equal((await t.api.command(message, sender)).needsToolbar, true);
  await t.api.disable();
  assert.equal(await t.api.get(), undefined);
  assert.deepEqual(t.messages, []);
  await assert.rejects(t.api.command(message, sender), /已关闭/);
  t.api.enable();
  t.deny(false);
  assert.equal(await t.api.resume(t.tab), false);
  assert.equal((await t.api.command(message, sender)).recording, true);
});

test("停用截断进行中的浏览器授权，重新启用也不启动旧选区", async () => {
  const t = setup();
  let release, entered;
  const authorizing = new Promise(resolve => { entered = resolve; });
  t.capture(() => new Promise(resolve => { release = resolve; entered(); }));
  const starting = t.api.command(message, sender);
  await authorizing;
  await t.api.disable();
  t.api.enable();
  release("stale-stream");
  await assert.rejects(starting, /已取消/);
  assert.equal(await t.api.get(), undefined);
  assert.deepEqual(t.messages, []);
});

test("停用会取消正在等待 offscreen 启动的同一会话，旧回执不会清除随后开始的录制", async () => {
  const t = setup();
  let release, entered;
  const acquiring = new Promise(resolve => { entered = resolve; });
  t.startOffscreen(() => new Promise(resolve => { release = resolve; entered(); }));
  const starting = t.api.command(message, sender);
  await acquiring;
  const oldId = t.messages[0].sessionId;
  await t.api.disable();
  assert.equal(t.messages[1].command, "CANCEL");
  assert.equal(t.messages[1].sessionId, oldId);
  assert.equal(await t.api.get(), undefined);
  t.api.enable();
  t.startOffscreen(async () => ({ recording: true }));
  await t.api.command(message, sender);
  const newId = (await t.api.get()).sessionId;
  assert.notEqual(newId, oldId);
  release({ recording: true });
  await assert.rejects(starting, /已取消/);
  assert.equal(await t.api.event({ event: "STOPPED", tabId: 1,
    pageUrl: message.url, sessionId: oldId }), false);
  assert.equal((await t.api.get()).sessionId, newId);
});


test("服务 worker 重启后按持久的关闭状态拒绝开始录制", async () => {
  const t = setup();
  t.enabled(false);
  await assert.rejects(t.api.command(message, sender), /已关闭/);
  assert.deepEqual(t.messages, []);
});


test("停用再启用后，迟到的录制开始通知不会唤醒原网页的控件", async () => {
  const t = setup();
  await t.api.command(message, sender);
  const oldId = (await t.api.get()).sessionId;
  let release, entered;
  const locating = new Promise(resolve => { entered = resolve; });
  t.lookup(() => new Promise(resolve => { release = resolve; entered(); }));
  const event = t.api.event({ event: "STARTED", tabId: 1,
    pageUrl: message.url, sessionId: oldId });
  await locating;
  await t.api.disable();
  t.api.enable();
  t.lookup(async () => t.tab);
  await t.api.command(message, sender);
  release(t.tab);
  assert.equal(await event, false);
  assert.deepEqual(t.tabMessages, []);
});


test("原生关闭暂时失败时保留本次会话以便重试清理", async () => {
  const t = setup();
  await t.api.command(message, sender);
  const activeId = (await t.api.get()).sessionId;
  t.cancelOffscreen(async () => { throw Error("native cancellation failed"); });
  t.closeOffscreen(async () => { throw Error("native close failed"); });
  await assert.rejects(t.api.disable(), /native cancellation failed/);
  assert.equal((await t.api.get()).sessionId, activeId);
  t.closeOffscreen(async () => {});
  await t.api.disable();
  assert.equal(await t.api.get(), undefined);
});
