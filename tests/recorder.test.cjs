const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  vm = require("node:vm"),
  fs = require("node:fs"),
  path = require("node:path"),
  Media = require("../extension/media.js");
function setup() {
  const session = {},
    messages = [];
  let deny = false,
    contexts = [],
    stopResult = { draftId: "saved-draft" },
    closed = 0;
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
                  ? { recording: true }
                  : { copied: true, cancelled: true },
          };
        },
      },
      storage: {
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
          contexts = [];
        },
      },
      tabCapture: {
        getMediaStreamId: async () => {
          if (deny) throw Error("requires invocation");
          return "test-stream";
        },
      },
      tabs: {
        get: async () => tab,
        sendMessage: async () => {},
        onRemoved: { addListener() {} },
        onUpdated: { addListener() {} },
      },
    };
  const context = vm.createContext({
    chrome,
    PageReviewMedia: Media,
    Date,
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
  await assert.rejects(
    t.api.command({ type: "RECORD_STOP" }, sender),
    /录制已中断/,
  );
  assert.equal(await t.api.get(), undefined);
  assert.equal(t.closed(), 1);
  t.stop({ draftId: "second-draft" });
  await t.api.command(message, sender);
  assert.equal(
    (await t.api.command({ type: "RECORD_STOP" }, sender)).draftId,
    "second-draft",
  );
  await t.api.event({ event: "STOPPED", tabId: 1, pageUrl: message.url });
  assert.equal(await t.api.get(), undefined);
  await t.api.copy("page-review read reference-id");
  assert.equal(t.messages.at(-1).command, "COPY");
});
