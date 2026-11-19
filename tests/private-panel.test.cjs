const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const asset = (name) => require("node:path").join(__dirname, "../extension", name);

test("private panel is an extension document available for embedding", () => {
  const manifest = JSON.parse(fs.readFileSync(asset("manifest.json"), "utf8"));
  assert.ok(manifest.web_accessible_resources.some(({ resources }) => resources.includes("panel.html")));
  assert.ok(fs.existsSync(asset("panel.html")));
});

test("panel accepts a render channel only after background verification and a matching capability", async () => {
  const parent = { postMessage: () => signals.push("ready") };
  const listeners = new Map(), surfaceListeners = new Map(), signals = [], renders = [], replies = [];
  const root = {
    addEventListener(name, callback) { surfaceListeners.set(name, callback); },
    replaceChildren() {},
    getElementById() { return null; },
    querySelector() { return null; },
    set innerHTML(value) { renders.push(value); },
  };
  const channel = "589b83ee-f9a0-48d5-aaa2-0e5995e743ec";
  const port = { postMessage: (value) => replies.push(value), close() {} };
  let authorized = false;
  const start = async () => {
    const context = vm.createContext({
      parent,
      window: {},
      location: { hash: "#" + channel },
      chrome: { runtime: { sendMessage: async () => ({ ok: authorized }) } },
      document: { createElement: () => ({
        attachShadow: () => root,
      }), body: { append() {} } },
      PageReviewStyles: "",
      CSSStyleSheet: class { replaceSync() {} },
      ResizeObserver: class { observe() {} disconnect() {} },
      addEventListener: (name, handler) => listeners.set(name, handler),
      removeEventListener: (name) => listeners.delete(name),
    });
    await vm.runInContext(fs.readFileSync(asset("private-panel-frame.js"), "utf8"), context);
  };

  await start();
  assert.deepEqual(signals, []);
  assert.equal(listeners.has("message"), false);

  authorized = true;
  await start();
  assert.deepEqual(signals, ["ready"]);
  const init = listeners.get("message");
  init({ isTrusted: true, source: {}, data: { type: "PAGE_REVIEW_PANEL_INIT", channel }, ports: [port] });
  init({ isTrusted: true, source: parent, data: { type: "PAGE_REVIEW_PANEL_INIT", channel: "guessed" }, ports: [port] });
  init({ isTrusted: false, source: parent, data: { type: "PAGE_REVIEW_PANEL_INIT", channel }, ports: [port] });
  assert.equal(port.onmessage, undefined);
  init({ isTrusted: true, source: parent, data: { type: "PAGE_REVIEW_PANEL_INIT", channel }, ports: [port] });
  assert.equal(replies[0]?.kind, "ready");
  port.onmessage({ data: { kind: "render", revision: 1, html: "<p>private</p>", context: {} } });
  assert.deepEqual(renders, ["<p>private</p>"]);
  const click = surfaceListeners.get("click");
  const event = {
    target: { closest: () => ({ dataset: { action: "delete" } }) },
    preventDefault() {},
  };
  click({ ...event, isTrusted: false });
  assert.equal(replies.length, 1);
  click({ ...event, isTrusted: true });
  assert.equal(replies[1]?.kind, "action");
});

test("copy prerequisites open connection settings and preserve the original panel", async () => {
  const source = fs.readFileSync(asset("content.js"), "utf8");
  const copyPage = source.slice(source.indexOf("  async function copyPage("),
    source.indexOf("  async function discardDraft("));
  for (const code of ["login_required", "cli_not_connected"]) {
    const state = { panel: "menu" };
    const context = vm.createContext({
      state, renderPanel() {},
      send: async (type) => {
        if (type === "CLOUD_SETUP") return { configured: true, cliConnections: [] };
        throw Object.assign(new Error(code), { code });
      },
    });
    await vm.runInContext(copyPage + "\ncopyPage()", context);
    assert.equal(state.panel, "settings");
    assert.equal(state.copyResumePanel, "menu");
    assert.equal(state.copyIssue, null);
    assert.equal(state.cloud.configured, code === "cli_not_connected");
  }
});

test("signing in from connection settings resumes the pending clipboard action", async () => {
  const source = fs.readFileSync(asset("content.js"), "utf8");
  const action = source.slice(source.indexOf("  async function action("),
    source.indexOf("\n  }", source.indexOf("  async function action(")) + 4);
  const copy = source.slice(source.indexOf("  async function resumeCopy("),
    source.indexOf("  async function discardDraft("));
  const state = { panel: "settings", copyResumePanel: "notes", copyFormat: "full" };
  const calls = [];
  const context = vm.createContext({
    state, renderPanel() {}, loadNotes() {}, toast() {},
    clipboard: async text => calls.push(text),
    send: async (type, payload) => {
      calls.push(type);
      if (type === "CLOUD_LOGIN") assert.equal(payload.resume, "copy");
      if (type === "CREATE_HANDOFF") return { text: "example full instruction", reference: "example reference", count: 1 };
    },
  });
  await vm.runInContext(action + copy + '\naction({ action: "login" })', context);
  assert.deepEqual(calls, ["CLOUD_LOGIN", "CREATE_HANDOFF", "example full instruction"]);
  assert.equal(state.panel, "notes");
  assert.equal(state.copyResumePanel, null);
});

test("opening and closing the menu does not wait for list or cloud reads", async () => {
  const source = fs.readFileSync(asset("content.js"), "utf8");
  const action = source.slice(source.indexOf("  async function action("),
    source.indexOf("\n  }", source.indexOf("  async function action(")) + 4);
  const panels = [];
  const state = { panel: null };
  const never = new Promise(() => {});
  const context = vm.createContext({
    state,
    loadNotes: () => never,
    refreshPageState: () => never,
    renderPanel: () => panels.push(state.panel),
    renderWidget() {},
    toast() {},
    suppressClick: 0,
    performance: { now: () => 1 },
  });
  await vm.runInContext(action + '\naction({ action: "toggle" })', context);
  await vm.runInContext('action({ action: "toggle" })', context);
  assert.deepEqual(panels, ["menu", null]);
});

test("取消重选会清除录制前的评论，继续重选时则保留", async () => {
  const source = fs.readFileSync(asset("content.js"), "utf8");
  const cut = (from, to) => source.slice(source.indexOf("  " + from), source.indexOf("  " + to));
  const seed = { note: { comment: "录制前评论" } };
  const state = { mode: "browse", panel: "record", record: { seed } };
  const context = vm.createContext({
    state, regionDrag: null, regionCursorSheet: {}, document: { adoptedStyleSheets: [] },
    renderPanel() {}, renderWidget() {}, renderMarkers() {}, highlight() {}, toast() {},
  });
  vm.runInContext(cut("function setMode(", "function enter(") +
    cut("async function action(", "function orbDown(") +
    cut("function keyDown(", "async function clipboard("), context);
  await vm.runInContext('action({ action: "reselect-record" })', context);
  assert.equal(state.recordSeed, seed);
  vm.runInContext('keyDown({ key: "Escape" })', context);
  assert.equal(state.mode, "browse");
  assert.equal(state.recordSeed, null);
});

test("the complete content script initializes and reads the enabled setting", () => {
  const messages = [];
  const context = vm.createContext({
    PageReviewCore: {},
    location: { href: "https://example.com/" },
    window: { addEventListener() {} },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        async sendMessage({ type }) {
          messages.push(type);
          return { ok: true, value: { enabled: false } };
        },
      },
      storage: { onChanged: { addListener() {} } },
    },
  });
  vm.runInContext(fs.readFileSync(asset("content.js"), "utf8"), context);
  assert.equal(typeof context.__pageReviewController.refresh, "function");
  assert.deepEqual(messages, ["GET_SETTINGS"]);
});

test("unchanged open panel keeps its DOM when refreshed or repositioned", async () => {
  const messages = [];
  const sendPort = { postMessage(message) { messages.push(message); } };
  const frame = { style: {}, contentWindow: { postMessage() {} } };
  let onMessage;
  const context = vm.createContext({
    URL, AbortController,
    chrome: { runtime: { getURL: () => "https://extension.invalid/panel.html" } },
    window: { addEventListener(_name, callback) { onMessage = callback; } },
    document: { createElement: () => frame },
    MessageChannel: class {
      port1 = sendPort;
      port2 = {};
    },
    setTimeout() {},
    clearTimeout() {},
  });
  vm.runInContext(fs.readFileSync(asset("private-panel.js"), "utf8"), context);
  const panel = context.PageReviewPrivatePanel({
    container: { append() {} },
    send: async () => "channel",
  });
  const html = "<section>评注 0</section>";
  const layout = { dock: { x: 100, y: 100 } };
  panel.render(html, layout, { focus: false });
  await new Promise(setImmediate);
  onMessage({ isTrusted: true, source: frame.contentWindow, origin: "https://extension.invalid", data: { type: "PAGE_REVIEW_PANEL_READY" } });
  sendPort.onmessage({ data: { kind: "ready" } });
  panel.render(html, { dock: { x: 100, y: 100 } }, { focus: false });
  panel.render(html, { dock: { x: 120, y: 100 } }, { focus: false });
  panel.render("<section>评注 1</section>", layout, { focus: false });
  assert.deepEqual(messages.map((message) => message.kind), ["render", "position", "render"]);
  assert.equal(messages[1].revision, messages[0].revision);
});
