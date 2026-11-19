/* Test-only media input. The real offscreen cropper/MediaRecorder runs against a
   synthetic Canvas stream. This does NOT validate Chrome tabCapture permission. */
(function () {
  // Ego changes tab visibility between automation actions. Keep this synthetic
  // recording fixture active; native visibility interruption is tested separately.
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => false,
  });
  const parentMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
  let frame, ready;
  chrome.runtime.sendMessage = (message) =>
    message.target === "offscreen"
      ? ready.then(
          () =>
            new Promise((resolve) =>
              frame.contentWindow.__offscreenListener(
                message,
                { id: chrome.runtime.id },
                resolve,
              ),
            ),
        )
      : parentMessage(message);
  chrome.offscreen = {
    hasDocument: async () => Boolean(frame),
    createDocument: async () => {
      frame = document.createElement("iframe");
      frame.hidden = true;
      ready = new Promise((resolve) => (frame.onload = resolve));
      frame.src = "/offscreen.html";
      document.documentElement.append(frame);
      await ready;
    },
    closeDocument: async () => {
      frame?.remove();
      frame = null;
    },
  };
  chrome.tabCapture = {
    getMediaStreamId: async () => {
      if (globalThis.__rejectRecording) throw Error("test permission rejected");
      return "synthetic-test-stream";
    },
  };
  chrome.tabs.sendMessage = async (id, message) => {
    for (const listener of globalThis.__adapterContentListeners)
      listener(message, {}, () => {});
  };
  chrome.tabs.onRemoved = { addListener() {} };
  chrome.tabs.onUpdated = { addListener() {} };
  globalThis.__syntheticCaptureSource = () => {
    const canvas = document.createElement("canvas");
    canvas.width = innerWidth;
    canvas.height = innerHeight;
    const ctx = canvas.getContext("2d"),
      start = performance.now();
    let track;
    function draw() {
      if (track?.readyState !== "ended") {
        ctx.fillStyle = "#edf2e9";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#385f52";
        ctx.font = "30px sans-serif";
        ctx.fillText("区域录制 · 合成测试输入", 80, 130);
        ctx.fillStyle = "#fff";
        ctx.fillRect(80, 180, 420, 200);
        ctx.fillStyle = "#2864ef";
        ctx.fillRect(
          100 + Math.sin((performance.now() - start) / 600) * 35,
          220,
          90,
          44,
        );
        ctx.fillStyle = "#899ea3";
        ctx.font = "20px sans-serif";
        ctx.fillText("MediaRecorder / crop / keyframes", 80, 430);
        requestAnimationFrame(draw);
      }
    }
    draw();
    const stream = canvas.captureStream(24);
    track = stream.getVideoTracks()[0];
    globalThis.__syntheticTrack = track;
    return stream;
  };
})();
