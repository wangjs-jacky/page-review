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
