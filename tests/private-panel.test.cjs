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
      if (type === "GET_PAGE_REFERENCE") return { text: "example full instruction", reference: "example reference", count: 1 };
    },
  });
  await vm.runInContext(action + copy + '\naction({ action: "login" })', context);
  assert.deepEqual(calls, ["CLOUD_LOGIN", "GET_PAGE_REFERENCE", "example full instruction"]);
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
  panel.prepare();
  await new Promise(setImmediate);
  assert.equal(frame.hidden, undefined, "the collapsed iframe retains its viewport");
  assert.equal(frame.style.visibility, "hidden");
  panel.render(html, layout, { focus: false });
  assert.equal(frame.style.visibility, "visible");
  onMessage({ isTrusted: true, source: frame.contentWindow, origin: "https://extension.invalid", data: { type: "PAGE_REVIEW_PANEL_READY" } });
  sendPort.onmessage({ data: { kind: "ready" } });
  panel.render(html, { dock: { x: 100, y: 100 } }, { focus: false });
  panel.render(html, { dock: { x: 120, y: 100 } }, { focus: false });
  panel.render("<section>评注 1</section>", layout, { focus: false });
  assert.deepEqual(messages.map((message) => message.kind), ["render", "position", "render"]);
  assert.equal(messages[1].revision, messages[0].revision);
  panel.render("", layout, {});
  assert.equal(frame.hidden, undefined);
  assert.equal(frame.style.visibility, "hidden");
  assert.equal(frame.style.pointerEvents, "none");
  assert.equal(frame.style.clipPath, "inset(100%)");
  panel.render(html, layout, { focus: true });
  assert.equal(frame.style.visibility, "visible");
});

test("page mutations and scroll keep the same connected annotation marker", () => {
  const source = fs.readFileSync(asset("content.js"), "utf8");
  const markerCode = source.slice(source.indexOf("  function markRect("),
    source.indexOf("  function panelHead("));
  const children = [];
  const markerRoot = {
    children,
    append(node) { children.push(node); },
    replaceChildren() { children.length = 0; },
    set innerHTML(_) { children.length = 0; },
  };
  let top = 90;
  const note = { id: "03", type: "element" };
  const state = {
    notes: [note], showMarkers: true, mode: "browse",
    matches: new Map([[note.id, {
      status: "found",
      element: { getBoundingClientRect: () => ({ top, left: 50, width: 50, height: 100 }) },
    }]]),
  };
  const context = vm.createContext({
    state, innerWidth: 800, innerHeight: 600,
    shadow: { getElementById: () => markerRoot },
    document: { createElement: () => ({
      dataset: {}, style: {}, setAttribute() {},
      remove() { children.splice(children.indexOf(this), 1); },
    }) },
  });
  vm.runInContext(markerCode + "\nrenderMarkers()", context);
  const marker = children[0];
  top = 130;
  vm.runInContext("renderMarkers()", context);
  assert.equal(children[0], marker);
  assert.equal(marker.style.top, "118px");
  state.notes = [];
  vm.runInContext("renderMarkers()", context);
  assert.equal(children.length, 0);
});

test("repeated annotation clicks share the asset request and a late result cannot reopen the drawer", async () => {
  const source = fs.readFileSync(asset("content.js"), "utf8");
  const peek = source.slice(source.indexOf("  async function peek("),
    source.indexOf("  function locate("));
  const state = { panel: null, notes: [{ id: "03" }] };
  let requests = 0;
  let renders = 0;
  let resolveAsset;
  const assetResult = new Promise((resolve) => { resolveAsset = resolve; });
  const context = vm.createContext({
    state, renderPanel() { renders++; },
    send() { requests++; return assetResult; },
  });
  const first = vm.runInContext(peek + '\npeek("03")', context);
  assert.equal(state.panel, "peek");
  const repeat = vm.runInContext('peek("03")', context);
  assert.equal(requests, 1);
  assert.equal(renders, 1);
  state.panel = null;
  resolveAsset({ viewport: "saved image" });
  await Promise.all([first, repeat]);
  assert.equal(state.panel, null);
  assert.equal(renders, 1);
});

test("open annotation switches to another marker and protects changes before switching", async () => {
  const source = fs.readFileSync(asset("content.js"), "utf8");
  const start = source.indexOf("  async function action(");
  const action = source.slice(start, source.indexOf("\n  }", start) + 4);
  const first = { id: "01", comment: "first", feedback: "" };
  const second = { id: "07", comment: "second", feedback: "" };
  const state = { notes: [first, second], matches: new Map() };
  const rendered = [], notices = [];
  const context = vm.createContext({
    state, setMode() {}, renderPanel() { rendered.push(state.draft.note.id); },
    toast(message) { notices.push(message); },
  });
  vm.runInContext(action, context);
  const click = (id) => context.action({ action: "edit", id });
  await click(first.id);
  await click(second.id);
  assert.equal(state.draft.note.comment, second.comment);
  await click(second.id);
  assert.deepEqual(rendered, [first.id, second.id]);
  state.draft.note.feedback = "positive";
  await click(first.id);
  assert.equal(state.draft.note.id, second.id);
  assert.equal(state.draft.note.feedback, "positive");
  assert.equal(notices.length, 1);
});

test("anchored editor keeps its scroll offset and hides outside the viewport", () => {
  const source = fs.readFileSync(asset("private-panel-frame.js"), "utf8");
  const start = source.indexOf("  function layout()");
  const layout = source.slice(start, source.indexOf("  function updateComposer()", start));
  const anchor = { left: 240, top: 430, width: 240, height: 70 };
  const style = {};
  const element = {
    style,
    classList: { contains: name => ["editor", "popover"].includes(name), toggle() {} },
    getBoundingClientRect: () => {
      const top = parseFloat(style.top) || 0;
      return { width: 350, height: 200, left: 250, right: 600, top, bottom: top + 200 };
    },
  };
  const messages = [];
  const context = vm.createContext({
    panel: () => element, surface: { querySelector: () => null },
    context: { anchor }, innerWidth: 1200, innerHeight: 650, editorOffset: undefined,
    PageReviewCore: require("../extension/core.js"),
    post: (_kind, data) => messages.push(data),
  });
  vm.runInContext(layout + "\nlayout()", context);
  const initial = parseFloat(style.top);
  assert(initial >= 15);
  anchor.top -= 260;
  vm.runInContext("layout()", context);
  assert.equal(parseFloat(style.top), initial - 260);
  anchor.top = -100;
  vm.runInContext("layout()", context);
  assert.equal(messages.at(-1).hidden, true);
  assert.equal(style.visibility, "hidden");
  anchor.top = 430;
  vm.runInContext("layout()", context);
  assert.equal(parseFloat(style.top), initial);
  assert.equal(style.visibility, "");
});

test("the orb opens its menu over an annotation and recording protects only unsaved edits", async () => {
  const source = fs.readFileSync(asset("content.js"), "utf8");
  const start = source.indexOf("  async function action(");
  const action = source.slice(start, source.indexOf("\n  }", start) + 4);
  const panels = [], modes = [], notices = [];
  const originalNote = { id: "03", comment: "saved", feedback: "positive" };
  const draft = { note: { ...originalNote }, originalNote };
  const state = { panel: "editor", draft };
  const context = vm.createContext({
    state, renderPanel() { panels.push(state.panel); }, renderWidget() {},
    refreshPageState: async () => {}, enter(mode) { modes.push(mode); },
    toast(message) { notices.push(message); }, suppressClick: 0, performance,
  });
  vm.runInContext(action, context);
  const click = (action) => context.action({ action });
  await click("toggle");
  assert.equal(state.panel, "menu");
  await click("toggle");
  assert.equal(state.panel, "editor");
  await click("toggle");
  draft.note.comment = "unsaved";
  await click("record");
  assert.equal(state.panel, "editor");
  assert.equal(state.draft.note.comment, "unsaved");
  assert.equal(notices.length, 1);
  assert.equal(modes.length, 0);
  draft.note.comment = originalNote.comment;
  await click("toggle");
  await click("record");
  assert.equal(state.draft, null);
  assert.deepEqual(modes, ["record-area"]);
  state.panel = "peek";
  await click("toggle");
  assert.equal(panels.at(-1), "menu");
});
