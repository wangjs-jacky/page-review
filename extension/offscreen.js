"use strict";
let recording = null;
const dataURL = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(Error("附件读取失败"));
    r.readAsDataURL(blob);
  });
const notify = (type, data = {}) =>
  chrome.runtime
    .sendMessage({ type: "RECORD_EVENT", event: type, ...data })
    .catch(() => {});
async function start(message) {
  if (recording) throw Error("已有录制正在进行");
  const { streamId, rect, viewport, pageUrl, tabId, sessionId } = message;
  PageReviewMedia.region(rect, viewport);
  const eventData = { tabId, pageUrl, sessionId };
  let stream, canvasStream, pipeline, limit;
  const release = () => {
    clearTimeout(limit);
    pipeline?.abort();
    for (const track of [
      ...(stream?.getTracks() || []),
      ...(canvasStream?.getTracks() || []),
    ]) track.stop();
    if (recording === attempt) recording = null;
  };
  const attempt = {
    sessionId,
    cancelled: false,
    cancel() {
      attempt.cancelled = true;
      release();
    },
  };
  recording = attempt;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
      },
    });
    if (attempt.cancelled) throw Error("录制已取消");
    if (typeof MediaStreamTrackProcessor !== "function" ||
        typeof MediaStreamTrackGenerator !== "function")
      throw Error("当前浏览器不支持区域录制");
    const processor = new MediaStreamTrackProcessor({ track: stream.getVideoTracks()[0] }),
      generator = new MediaStreamTrackGenerator({ kind: "video" }),
      canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { alpha: false }),
      frames = [],
      chunks = [];
    let bytes = 0,
      started = performance.now(),
      stopping = false;
    function draw(frame) {
      const crop = PageReviewMedia.crop(rect, viewport, frame.displayWidth, frame.displayHeight);
      if (!frames.length) {
        canvas.width = crop.width;
        canvas.height = crop.height;
      }
      ctx.drawImage(
        frame,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      if (
        frames.length < 6 &&
        (frames.length === 0 ||
          (performance.now() - started) / 1000 >= frames.length * 3)
      )
        frames.push({
          at: (performance.now() - started) / 1000,
          data: canvas.toDataURL("image/jpeg", 0.85),
        });
    }
    // Offscreen documents have no presented video frames. Consume the actual
    // track's frame events and feed a generated track; no display clock or timer.
    canvasStream = new MediaStream([generator]);
    const mime = [
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ].find((t) => MediaRecorder.isTypeSupported(t));
    if (!mime) throw Error("当前浏览器不支持WebM录制");
    const recorder = new MediaRecorder(canvasStream, {
      mimeType: mime,
      videoBitsPerSecond: 2500000,
    });
    let resolveStopped, rejectStopped;
    const stopped = new Promise((resolve, reject) => {
      resolveStopped = resolve;
      rejectStopped = reject;
    });
    stopped.catch(() => {});
    const stop = (reason) => {
      if (stopping) return stopped;
      stopping = true;
      attempt.reason = reason || "";
      recorder.stop();
      return stopped;
    };
    attempt.stop = stop;
    attempt.cancel = () => {
      attempt.cancelled = true;
      if (!stopping) {
        stopping = true;
        try {
          recorder.stop();
        } catch {}
      }
      release();
      rejectStopped(Error("录制已取消"));
    };
    recorder.ondataavailable = (e) => {
      if (!attempt.cancelled && e.data.size) {
        bytes += e.data.size;
        chunks.push(e.data);
        if (bytes >= 28000000) stop("已达到录制大小上限");
      }
    };
    recorder.onerror = () => {
      if (attempt.cancelled) return;
      attempt.cancelled = true;
      stopping = true;
      release();
      rejectStopped(Error("录制中断，请重录"));
      notify("ERROR", { ...eventData, message: "录制中断，请重录" });
    };
    recorder.onstop = async () => {
      if (attempt.cancelled) return;
      try {
        const duration = Math.min(120, (performance.now() - started) / 1000),
          blob = new Blob(chunks, { type: "video/webm" });
        if (!frames.length || !blob.size || blob.size > 32000000 || duration < 0.15)
          throw Error("录制为空或超出大小限制，请重录");
        const final = {
          at: Math.max(0, duration - 0.02),
          data: canvas.toDataURL("image/jpeg", 0.85),
        };
        if (frames.length < 6) frames.push(final);
        else frames[frames.length - 1] = final;
        const selected = frames
            .filter((f, i) => !i || f.at - frames[i - 1].at > 0.1)
            .slice(0, 6),
          id = crypto.randomUUID(),
          asset = {
            viewport: final.data,
            width: canvas.width,
            height: canvas.height,
            video: await dataURL(blob),
            frames: selected,
            recording: {
              duration,
              region: rect,
              viewport: { width: viewport.width, height: viewport.height },
              width: canvas.width,
              height: canvas.height,
              frames: selected.map((f, i) => ({
                at: f.at,
                role: "frame-" + i,
              })),
            },
            capturedAt: new Date().toISOString(),
          };
        if (attempt.cancelled) return;
        await PageReviewDB.putDraft({
          id,
          pageUrl,
          tabId,
          asset,
          createdAt: new Date().toISOString(),
        });
        if (attempt.cancelled) {
          await PageReviewDB.deleteDraft(id);
          return;
        }
        release();
        resolveStopped({ draftId: id });
        await notify("STOPPED", { ...eventData, draftId: id, reason: attempt.reason });
      } catch (e) {
        if (attempt.cancelled) return;
        release();
        rejectStopped(e);
        await notify("ERROR", { ...eventData, message: e.message });
      }
    };
    for (const track of stream.getTracks())
      track.addEventListener("ended", () => stop("录制已中断，保留已录部分"), {
        once: true,
      });
    recorder.start(1000);
    pipeline = new AbortController();
    processor.readable.pipeThrough(new TransformStream({
      transform(frame, controller) {
        let output;
        try {
          if (stopping) return;
          draw(frame);
          output = new VideoFrame(canvas, { timestamp: frame.timestamp });
          controller.enqueue(output);
          output = null;
        } finally {
          output?.close();
          frame.close();
        }
      },
    })).pipeTo(generator.writable, { signal: pipeline.signal }).catch((error) => {
      if (!stopping) {
        console.error("Page Review frame pipeline", error.name, error.message);
        stop("录制已中断，保留已录部分").catch(() => {});
      }
    });
    limit = setTimeout(() => stop("已达到两分钟上限"), 120000);
    await notify("STARTED", eventData);
    if (attempt.cancelled) throw Error("录制已取消");
    return { recording: true };
  } catch (e) {
    release();
    throw e;
  }
}
async function copyText(text) {
  if (typeof text !== "string" || text.length > 16000)
    throw Error("复制内容无效");
  const input = document.createElement("textarea");
  document.body.append(input);
  input.value = text;
  input.select();
  try {
    if (!document.execCommand("copy")) throw Error("剪贴板不可用");
    return { copied: true };
  } finally {
    input.remove();
  }
}
chrome.runtime.onMessage.addListener((m, s, respond) => {
  if (m?.target !== "offscreen" || s.id !== chrome.runtime.id) return;
  const ownRecording = recording?.sessionId === m.sessionId ? recording : null;
  if (m.command === "CANCEL") {
    ownRecording?.cancel();
    respond({ ok: true, value: { cancelled: true } });
    return;
  }
  const work =
    m.command === "COPY"
      ? copyText(m.text)
      : m.command === "START"
        ? start(m)
        : m.command === "STOP"
          ? ownRecording?.stop?.(m.reason)
          : Promise.resolve({ recording: Boolean(recording) });
  Promise.resolve(work).then(
    (value) => respond({ ok: true, value }),
    (e) => respond({ ok: false, error: e.message }),
  );
  return true;
});
