(function (root) {
  "use strict";
  let creating, starting, disabled = false, generation = 0;
  let sessionQueue = Promise.resolve();
  const get = async () =>
    (await chrome.storage.session.get("recordingSession")).recordingSession;
  const save = (value) =>
    value
      ? chrome.storage.session.set({ recordingSession: value })
      : chrome.storage.session.remove("recordingSession");
  const owns = (session, tabId, pageUrl) =>
    session?.tabId === tabId && session.pageUrl === pageUrl;
  function withSession(work) {
    const next = sessionQueue.then(async () => work(await get()));
    sessionQueue = next.catch(() => {});
    return next;
  }
  async function hasOffscreen() {
    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [chrome.runtime.getURL("offscreen.html")],
      });
      return Boolean(contexts.length);
    }
    return chrome.offscreen.hasDocument?.();
  }
  async function offscreen() {
    if (await hasOffscreen()) return;
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
    const r = await chrome.runtime.sendMessage({
      target: "offscreen",
      command,
      ...payload,
    });
    if (!r?.ok) throw Error(r?.error || "录制暂不可用");
    return r.value;
  }
  async function cancel(session) {
    try {
      if (!session.pending && (await hasOffscreen()))
        await call("CANCEL", { sessionId: session.sessionId });
    } catch (error) {
      try {
        await chrome.offscreen.closeDocument();
      } catch {
        if (await hasOffscreen()) throw error;
      }
    }
    await save(null);
    return { cancelled: true };
  }
  function disable() {
    disabled = true;
    generation++;
    starting = null;
    return withSession((session) => session && cancel(session));
  }
  async function start(message, tabId, pending) {
    if (disabled) throw Error("网页评注已关闭");
    if (starting) throw Error("已有区域正在录制");
    const session = {
      sessionId: crypto.randomUUID(),
      tabId,
      pageUrl: message.url,
      rect: PageReviewMedia.region(message.rect, message.viewport),
      viewport: message.viewport,
      at: Date.now(),
      pending: true,
    };
    if (!PageReviewMedia.controls(session.rect, session.viewport))
      throw Error("请缩小选区，为录制按钮留出空间");
    const checkAttempt = () => {
      if (starting !== session) throw Error("录制已取消，请重新框选");
    };
    starting = session;
    try {
      const { enabled } = await chrome.storage.local.get({ enabled: false });
      checkAttempt();
      if (!enabled) throw Error("网页评注已关闭");
      const tab = await chrome.tabs.get(tabId);
      checkAttempt();
      if (tab.url !== session.pageUrl) throw Error("网页已切换，请重新框选");
      await withSession((active) => {
        checkAttempt();
        if (active && !active.pending) throw Error("已有区域正在录制");
        if (pending && active?.sessionId !== pending.sessionId)
          throw Error("录制已取消，请重新框选");
      });
      let streamId;
      try {
        streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
      } catch {
        await withSession(async () => {
          checkAttempt();
          await save(session);
        });
        checkAttempt();
        return { needsToolbar: true };
      }
      checkAttempt();
      await offscreen();
      let result;
      await withSession(async () => {
        checkAttempt();
        session.pending = false;
        await save(session);
        checkAttempt();
        // The offscreen document sends events while a start is pending.
        // Keep the session queue free while its reply is outstanding.
        result = call("START", { streamId, ...session });
        result.catch(() => {});
      });
      const value = await result;
      checkAttempt();
      return value;
    } catch (error) {
      await withSession((active) =>
        active?.sessionId === session.sessionId && cancel(active),
      );
      throw error;
    } finally {
      if (starting === session) starting = null;
    }
  }
  async function resume(tab) {
    if (disabled || starting) return false;
    const currentGeneration = generation;
    const pending = await withSession(async (session) => {
      if (!session?.pending || disabled || generation !== currentGeneration)
        return;
      if (
        !owns(session, tab.id, tab.url) ||
        Date.now() - session.at > 180000
      ) {
        await save(null);
        throw Error("选区已过期，请回到页面重新框选");
      }
      return session;
    });
    if (!pending || disabled || generation !== currentGeneration) return false;
    const result = await start(
      { url: pending.pageUrl, rect: pending.rect, viewport: pending.viewport },
      tab.id,
      pending,
    );
    if (result.needsToolbar)
      throw Error("此页录制未获浏览器授权，请重新打开普通网页后重试");
    return true;
  }
  async function command(message, sender) {
    const { tab, url } = sender;
    if (message.type === "RECORD_START") return start(message, tab.id);
    const cancelRequest = message.type === "RECORD_CANCEL";
    const cancelledStart = cancelRequest && owns(starting, tab.id, url);
    if (cancelledStart) starting = null;
    let stopped, stoppedSession;
    const cancelled = await withSession(async (session) => {
      if (!owns(session, tab.id, url)) {
        if (cancelledStart) return { cancelled: true };
        throw Error("本页没有进行中的录制");
      }
      if (session.pending || cancelRequest) return cancel(session);
      stoppedSession = session;
      stopped = (async () => {
        if (!(await hasOffscreen())) return;
        return call("STOP", { sessionId: session.sessionId, reason: message.reason });
      })();
      stopped.catch(() => {});
    });
    if (cancelled) return cancelled;
    try {
      const result = await stopped;
      if (!result?.draftId) throw Error("录制已中断，请重试");
      return result;
    } catch (error) {
      await withSession((session) =>
        session && session.sessionId === stoppedSession.sessionId && cancel(session),
      );
      throw error;
    }
  }
  async function event(message) {
    const tab = await chrome.tabs.get(message.tabId).catch(() => null);
    return withSession(async (session) => {
      if (
        !owns(session, message.tabId, message.pageUrl) ||
        session.sessionId !== message.sessionId ||
        (message.event === "STARTED" && disabled)
      )
        return false;
      if (message.event !== "STARTED") await save(null);
      if (tab?.url === session.pageUrl)
        chrome.tabs.sendMessage(tab.id, {
          ...message,
          type: "PAGE_REVIEW_RECORD_EVENT",
        }).catch(() => {});
      return true;
    });
  }
  function invalidate(tabId, url) {
    const stale = (session) =>
      session?.tabId === tabId && (!url || session.pageUrl !== url);
    if (stale(starting)) starting = null;
    return withSession((session) => stale(session) && cancel(session));
  }
  chrome.tabs.onRemoved?.addListener((id) => invalidate(id).catch(console.error));
  chrome.tabs.onUpdated?.addListener((id, change) => {
    if (change.url) invalidate(id, change.url).catch(console.error);
  });
  root.PageReviewRecorder = {
    async copy(text) {
      await offscreen();
      return call("COPY", { text });
    },
    command,
    resume,
    event,
    get,
    disable,
    enable() {
      disabled = false;
    },
  };
})(globalThis);
