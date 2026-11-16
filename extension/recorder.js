(function (root) {
  "use strict";
  let creating;
  const get = async () =>
    (await chrome.storage.session.get("recordingSession")).recordingSession;
  const save = (value) =>
    value
      ? chrome.storage.session.set({ recordingSession: value })
      : chrome.storage.session.remove("recordingSession");
  async function offscreen() {
    const contexts = chrome.runtime.getContexts
      ? await chrome.runtime.getContexts({
          contextTypes: ["OFFSCREEN_DOCUMENT"],
          documentUrls: [chrome.runtime.getURL("offscreen.html")],
        })
      : null;
    if (
      contexts?.length ||
      (!contexts && (await chrome.offscreen.hasDocument?.()))
    )
      return;
    if (!creating)
      creating = chrome.offscreen
        .createDocument({
          url: "offscreen.html",
          reasons: ["USER_MEDIA", "CLIPBOARD"],
          justification:
            "Capture only the user selected webpage region and save its preview.",
        })
        .finally(() => {
          creating = null;
        });
    await creating;
  }
  async function call(command, payload = {}) {
    await offscreen();
    const r = await chrome.runtime.sendMessage({
      target: "offscreen",
      command,
      ...payload,
    });
    if (!r?.ok) throw Error(r?.error || "录制暂不可用");
    return r.value;
  }
  async function start(message, tab) {
    const region = PageReviewMedia.region(message.rect, message.viewport);
    if (!PageReviewMedia.controls(region, message.viewport))
      throw Error("请缩小选区，为录制按钮留出空间");
    const active = await get();
    if (active && !active.pending) throw Error("已有区域正在录制");
    if (tab.url !== message.url) throw Error("网页已切换，请重新框选");
    const session = {
      tabId: tab.id,
      pageUrl: message.url,
      rect: region,
      viewport: message.viewport,
      at: Date.now(),
      pending: true,
    };
    let streamId;
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({
        targetTabId: tab.id,
      });
    } catch {
      await save(session);
      return { needsToolbar: true };
    }
    await save({ ...session, pending: false });
    try {
      return await call("START", { streamId, ...session });
    } catch (e) {
      await save(null);
      throw e;
    }
  }
  async function resume(tab) {
    const pending = await get();
    if (!pending?.pending) return false;
    if (
      pending.tabId !== tab.id ||
      pending.pageUrl !== tab.url ||
      Date.now() - pending.at > 180000
    ) {
      await save(null);
      throw Error("选区已过期，请回到页面重新框选");
    }
    const result = await start(
      { url: pending.pageUrl, rect: pending.rect, viewport: pending.viewport },
      tab,
    );
    if (result.needsToolbar)
      throw Error("此页录制未获浏览器授权，请重新打开普通网页后重试");
    return true;
  }
  async function command(message, sender) {
    const session = await get();
    if (message.type === "RECORD_START")
      return start(message, await chrome.tabs.get(sender.tab.id));
    if (
      !session ||
      session.tabId !== sender.tab.id ||
      session.pageUrl !== sender.url
    )
      throw Error("本页没有进行中的录制");
    if (session.pending) {
      await save(null);
      return { cancelled: true };
    }
    try {
      const result = await call(
        message.type === "RECORD_STOP" ? "STOP" : "CANCEL",
        { reason: message.reason },
      );
      if (message.type !== "RECORD_STOP") await save(null);
      else if (!result?.draftId) {
        await save(null);
        throw Error("录制已中断，请重试");
      }
      return result;
    } catch (error) {
      await chrome.offscreen.closeDocument?.().catch(() => {});
      await save(null);
      throw error;
    }
  }
  async function event(message) {
    const session = await get();
    if (
      !session ||
      session.tabId !== message.tabId ||
      session.pageUrl !== message.pageUrl
    )
      return false;
    if (message.event !== "STARTED") await save(null);
    try {
      const tab = await chrome.tabs.get(session.tabId);
      if (tab.url === session.pageUrl)
        await chrome.tabs.sendMessage(tab.id, {
          ...message,
          type: "PAGE_REVIEW_RECORD_EVENT",
        });
    } catch {}
    return true;
  }
  async function invalidate(tabId, url) {
    const session = await get();
    if (session?.tabId === tabId && (!url || session.pageUrl !== url)) {
      if (!session.pending)
        await call("CANCEL").catch(() =>
          chrome.offscreen.closeDocument?.().catch(() => {}),
        );
      await save(null);
    }
  }
  chrome.tabs.onRemoved?.addListener((id) => invalidate(id));
  chrome.tabs.onUpdated?.addListener((id, change) => {
    if (change.url) invalidate(id, change.url);
  });
  root.PageReviewRecorder = {
    copy: (text) => call("COPY", { text }),
    command,
    resume,
    event,
    get,
  };
})(globalThis);
