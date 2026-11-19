const { test } = require("node:test"), assert = require("node:assert/strict");
const vm = require("node:vm"), fs = require("node:fs"), path = require("node:path");
const crypto = require("node:crypto"), Media = require("../extension/media.js");

function hiddenDocument({ acquire, store } = {}) {
  let listener, source, clock = 0, written;
  const frames = [], drafts = [], notifications = [], timers = new Set();
  class Track {
    stop() { this.stopped = true; }
    addEventListener() {}
  }
  class Stream {
    constructor(tracks) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    getVideoTracks() { return this.tracks; }
  }
  const input = new Track();
  let sourceCancelled = false, output;
  class Processor {
    constructor() {
      this.readable = new ReadableStream({
        start(controller) { source = controller; },
        cancel() { sourceCancelled = true; },
      });
    }
  }
  class Generator extends Track {
    constructor() {
      super(); output = this;
      this.writable = new WritableStream({
        write(frame) { frames.push({ pixel: frame.pixel, timestamp: frame.timestamp }); frame.close(); written?.(); },
      });
    }
  }
  const canvas = {
    getContext: () => ({ drawImage(frame) { canvas.pixel = frame.pixel; } }),
    toDataURL: () => "data:image/jpeg;base64," + Buffer.from(String(canvas.pixel)).toString("base64"),
  };
  class Frame {
    constructor(image, options) { this.pixel = image.pixel; this.timestamp = options.timestamp; }
    close() { this.closed = true; }
  }
  class Recorder {
    static isTypeSupported() { return true; }
    start() {}
    stop() {
      queueMicrotask(() => {
        this.ondataavailable({ data: new Blob([Buffer.from("test encoded media")]) });
        this.onstop();
      });
    }
  }
  class Reader {
    readAsDataURL(blob) {
      blob.arrayBuffer().then(bytes => {
        this.result = "data:video/webm;base64," + Buffer.from(bytes).toString("base64");
        this.onload();
      });
    }
  }
  const context = vm.createContext({
    chrome: { runtime: { id: "test", onMessage: { addListener(fn) { listener = fn; } },
      sendMessage: async message => { notifications.push(message); } } },
    navigator: { mediaDevices: { getUserMedia: async () => { await acquire; return new Stream([input]); } } },
    // No visible video element, rAF or video-frame callback exists in this fixture.
    document: { createElement(tag) { assert.equal(tag, "canvas"); return canvas; } },
    MediaStreamTrackProcessor: Processor, MediaStreamTrackGenerator: Generator,
    MediaStream: Stream, VideoFrame: Frame, MediaRecorder: Recorder, FileReader: Reader,
    PageReviewMedia: Media,
    PageReviewDB: {
      putDraft: async draft => { await store?.(); drafts.push(draft); },
      deleteDraft: async id => {
        const index = drafts.findIndex(draft => draft.id === id);
        if (index !== -1) drafts.splice(index, 1);
      },
    },
    performance: { now: () => clock }, crypto, Blob, ReadableStream, WritableStream,
    TransformStream, AbortController, Date, console, queueMicrotask,
    setTimeout: fn => { timers.add(fn); return fn; }, clearTimeout: fn => timers.delete(fn),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../extension/offscreen.js"), "utf8"), context);
  return {
    frames, drafts, notifications, input, timers,
    cancelled: () => sourceCancelled, output: () => output,
    clock: value => { clock = value; },
    call: (command, sessionId = "one") => new Promise(resolve => listener({ target: "offscreen", command, sessionId,
      streamId: "native-stream", tabId: 1, pageUrl: "https://example.com/guide",
      rect: { left: 100, top: 100, width: 300, height: 200 }, viewport: { width: 1000, height: 500 },
    }, { id: "test" }, resolve)),
    push: (pixel, time) => new Promise(resolve => {
      clock = time; written = resolve;
      const frame = { pixel, timestamp: time * 1000, displayWidth: 2000, displayHeight: 1000,
        close() { this.closed = true; } };
      source.enqueue(frame);
    }),
  };
}

test("隐藏offscreen按源帧事件录下连续变化，裁剪尺寸正确，不依赖视频呈现回调", async () => {
  const t = hiddenDocument();
  assert.equal((await t.call("START")).ok, true);
  await t.push("first", 0); await t.push("second", 3000); await t.push("last", 6000);
  assert.deepEqual(t.frames.map(f => f.pixel), ["first", "second", "last"]);
  assert.deepEqual(t.frames.map(f => f.timestamp), [0, 3000000, 6000000]);
  t.clock(6500);
  assert.equal((await t.call("STOP")).ok, true);
  assert.equal(t.drafts.length, 1);
  assert.equal(t.drafts[0].asset.recording.width, 600);
  assert.equal(t.drafts[0].asset.recording.height, 400);
  assert(t.drafts[0].asset.frames.length >= 3);
  await new Promise(setImmediate);
  assert.equal(t.cancelled(), true);
  assert.equal(t.input.stopped, true); assert.equal(t.output().stopped, true);
  assert.equal(t.timers.size, 0);
});

test("未收到源帧时拒绝空录制并清理输入输出轨道和等待中的流", async () => {
  const t = hiddenDocument();
  assert.equal((await t.call("START")).ok, true);
  t.clock(500);
  const stopped = await t.call("STOP");
  assert.equal(stopped.ok, false); assert.match(stopped.error, /录制为空/);
  await new Promise(setImmediate);
  assert.equal(t.drafts.length, 0); assert.equal(t.cancelled(), true);
  assert.equal(t.input.stopped, true); assert.equal(t.output().stopped, true);
  assert.equal(t.timers.size, 0);
});


test("取消正在录制的会话立即释放原生轨道，无需等待 WebM 收尾", async () => {
  const t = hiddenDocument();
  assert.equal((await t.call("START")).ok, true);
  await t.push("captured", 0);
  t.clock(600);
  const cancelled = t.call("CANCEL");
  assert.equal(t.input.stopped, true);
  assert.equal(t.output().stopped, true);
  assert.equal(t.timers.size, 0);
  assert.equal((await cancelled).ok, true);
  await new Promise(setImmediate);
  assert.equal(t.drafts.length, 0);
  assert.deepEqual(t.notifications.map((m) => m.event), ["STARTED"]);
});

test("等待 Chrome 交付轨道时取消，迟到的轨道立即释放", async () => {
  let release;
  const acquire = new Promise(resolve => { release = resolve; });
  const t = hiddenDocument({ acquire });
  const starting = t.call("START");
  assert.equal((await t.call("CANCEL")).ok, true);
  release();
  assert.equal((await starting).ok, false);
  assert.equal(t.input.stopped, true);
  assert.equal(t.output(), undefined);
  assert.deepEqual(t.notifications, []);
});

test("保存草稿进行中取消，只删除该次正在收尾的录制", { timeout: 1000 }, async () => {
  let release, entered;
  const storing = new Promise(resolve => { entered = resolve; });
  const t = hiddenDocument({ store: () => new Promise(resolve => { release = resolve; entered(); }) });
  t.drafts.push({ id: "existing-draft" });
  assert.equal((await t.call("START")).ok, true);
  await t.push("captured", 0);
  t.clock(600);
  const stopping = t.call("STOP");
  await storing;
  assert.equal((await t.call("CANCEL", "different")).ok, true);
  assert.equal(t.input.stopped, undefined);
  assert.equal((await t.call("CANCEL")).ok, true);
  assert.equal(t.input.stopped, true);
  release();
  assert.equal((await stopping).ok, false);
  await new Promise(setImmediate);
  assert.deepEqual(t.drafts.map(draft => draft.id), ["existing-draft"]);
  assert.deepEqual(t.notifications.map((m) => m.event), ["STARTED"]);
});
