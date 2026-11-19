"use strict";
importScripts(
  "core.js",
  "db.js",
  "cloud-config.js",
  "cloud.js",
  "login-tabs.js",
  "media.js",
  "recorder.js",
);
const Core = PageReviewCore,
  DB = PageReviewDB,
  SCRIPT_ID = "page-review-pages";
const SCRIPT_FILES = [
  "core.js", "media.js", "content-style.js", "private-panel.js", "content.js",
];
let actionQueue = Promise.resolve(),
  registrationQueue = Promise.resolve(),
  enabledChange = 0;
const captures = new Map();
const panelBindings = new Map();
const TabLogin = typeof PageReviewTabLoginFactory === "function" && chrome.runtime.onMessageExternal
  ? PageReviewTabLoginFactory({ chrome, loginOrigin: PageReviewCloudConfig.loginOrigin,
      complete: (context, returned) => Cloud.finishLogin(context, returned) })
  : null;
const Cloud =
  typeof PageReviewCloudFactory === "function"
    ? PageReviewCloudFactory({ db: DB, storage: chrome.storage.local, tabLogin: TabLogin })
    : null;
chrome.storage.local
  .setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch(console.error);
const cloudWorkspace = async () => (Cloud ? Cloud.workspace() : undefined);
const syncCloud = (page) => {
  if (Cloud) Cloud.sync(page ? { page } : undefined).catch(() => {});
};
const settings = () =>
  chrome.storage.local.get({
    enabled: false,
    dock: { side: "right", bottom: 24 },
  });
const librarySender = (sender) =>
  sender.id === chrome.runtime.id &&
  sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL("library.html");
function pageSenderUrl(sender) {
  if (
    sender.id !== chrome.runtime.id ||
    sender.frameId !== 0 ||
    !sender.tab?.id ||
    (sender.documentLifecycle && sender.documentLifecycle !== "active") ||
    !/^https?:\/\//.test(sender.url || "")
  )
    throw new Error("此页面不能调用网页评注");
  // Chrome can retain the content script's initial URL after History API navigation.
  const url = sender.tab.url || sender.url;
  if (!/^https?:\/\//.test(url) || new URL(url).origin !== new URL(sender.url).origin)
    throw new Error("此页面不能调用网页评注");
  return url;
}
function authorizePanel(channel, sender) {
  if (sender.url?.split(/[?#]/)[0] !== chrome.runtime.getURL("panel.html") ||
      !Number.isInteger(sender.frameId) || sender.frameId <= 0 ||
      (sender.documentLifecycle && sender.documentLifecycle !== "active"))
    throw Error("无法验证私有评注面板");
  const binding = panelBindings.get(sender.tab?.id);
  if (!binding || binding.expires <= Date.now() || binding.channel !== channel)
    throw Error("无法验证私有评注面板");
  panelBindings.delete(sender.tab.id);
  return true;
}
function reconcile(update) {
  const next = registrationQueue
    .catch(() => {})
    .then(async () => {
      if (update) {
        await update.stopping;
        await chrome.storage.local.set({ enabled: update.enabled });
      }
      const state = await settings(),
        allowed = await chrome.permissions.contains({
          origins: PageReviewCloudConfig.pageOrigins || ["<all_urls>"],
        });
      const enabled = state.enabled && allowed;
      if (!enabled && !update) await PageReviewRecorder.disable();
      if (state.enabled && !allowed)
        await chrome.storage.local.set({ enabled: false });
      const scripts = await chrome.scripting.getRegisteredContentScripts({
        ids: [SCRIPT_ID],
      });
      if (enabled) {
        const script = {
          id: SCRIPT_ID,
          js: SCRIPT_FILES,
          matches: PageReviewCloudConfig.pageOrigins || ["http://*/*", "https://*/*"],
          runAt: "document_idle",
          allFrames: false,
          persistAcrossSessions: true,
        };
        if (!scripts.length)
          await chrome.scripting.registerContentScripts([script]);
        else if (JSON.stringify(scripts[0].js) !== JSON.stringify(script.js) ||
                 JSON.stringify(scripts[0].matches) !== JSON.stringify(script.matches))
          await chrome.scripting.updateContentScripts([script]);
      }
      if (!enabled && scripts.length)
        await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
      if (enabled && update?.enabled && update.change === enabledChange)
        PageReviewRecorder.enable();
      if (state.enabled && !allowed) await notifySettings();
      await chrome.action.setBadgeBackgroundColor({ color: "#2864ef" });
      await chrome.action.setBadgeText({ text: enabled ? "ON" : "" });
      await chrome.action.setTitle({
        title: enabled ? "关闭网页评注" : "启用网页评注",
      });
      return enabled;
    });
  registrationQueue = next;
  return next;
}
async function notifySettings() {
  if (!chrome.tabs.sendMessage) return;
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(
    tabs
      .filter((tab) => tab.id)
      .map((tab) =>
        chrome.tabs.sendMessage(tab.id, {
          type: "PAGE_REVIEW_SETTINGS_CHANGED",
        }),
      ),
  );
}
async function setEnabled(enabled) {
  const change = ++enabledChange;
  const stopping = PageReviewRecorder.disable();
  stopping.catch(() => {});
  await reconcile({ enabled: Boolean(enabled), stopping, change });
  await notifySettings();
  return settings();
}
chrome.action.onClicked.addListener((tab) => {
  actionQueue = actionQueue
    .catch(() => {})
    .then(async () => {
      const state = await settings();
      if (state.enabled && await PageReviewRecorder.resume(tab)) return;
      const updated = await setEnabled(!state.enabled);
      if (updated.enabled && tab.id && /^https?:\/\//.test(tab.url || "")) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: SCRIPT_FILES,
        });
      }
      if (updated.enabled && !/^https?:\/\//.test(tab.url || ""))
        await chrome.action.setTitle({
          title: "已启用；请在普通 HTTP/HTTPS 网页上使用",
        });
    })
    .catch((error) =>
      chrome.action.setTitle({ title: `网页评注：${error.message}` }),
    );
});
chrome.runtime.onInstalled.addListener(() => {
  reconcile().catch(console.error);
});
chrome.runtime.onStartup.addListener(() => {
  reconcile().catch(console.error);
  syncCloud();
});
chrome.permissions.onRemoved.addListener(() => {
  reconcile().catch(console.error);
});
// Existing tabs also receive the tool when the user switches to them after enabling.
chrome.tabs.onActivated?.addListener(({ tabId }) => {
  settings()
    .then(async (state) => {
      if (!state.enabled) return;
      const tab = await chrome.tabs.get(tabId);
      if (/^https?:\/\//.test(tab.url || ""))
        await chrome.scripting.executeScript({
          target: { tabId },
          files: SCRIPT_FILES,
        });
    })
    .catch(() => {});
});

async function imageData(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 16384)
    binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return `data:${blob.type};base64,${btoa(binary)}`;
}
async function capture(message, tabId, pageUrl) {
  if (!pageUrl) throw new Error("此页面不能调用网页评注");
  if (!(await settings()).enabled) throw new Error("网页评注已关闭");
  if (message.url !== pageUrl) throw new Error("页面已经变化，请重新选择");
  const tab = await chrome.tabs.get(tabId);
  if (tab.url !== pageUrl) throw new Error("页面已经变化，请重新选择");
  const [active] = await chrome.tabs.query({
    active: true,
    windowId: tab.windowId,
  });
  if (active?.id !== tab.id)
    throw new Error("网页不在当前前台，未截取其他标签页");
  if (Date.now() - (captures.get(tab.id) || 0) < 600)
    throw new Error("截图操作过快，请稍后点重试截图");
  captures.set(tab.id, Date.now());
  const data = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  });
  const after = await chrome.tabs.get(tab.id),
    [activeAfter] = await chrome.tabs.query({
      active: true,
      windowId: tab.windowId,
    });
  if (after.url !== pageUrl || activeAfter?.id !== tab.id)
    throw new Error("截图期间页面已切换，本次画面未保存");
  const viewport = message.viewport;
  if (!viewport || viewport.width < 1 || viewport.height < 1)
    throw new Error("视口尺寸无效");
  const bitmap = await createImageBitmap(
    new Blob([Core.dataBytes(data)], { type: "image/png" }),
  );
  try {
    const ratioX = bitmap.width / viewport.width,
      ratioY = bitmap.height / viewport.height;
    const r = message.rect || {
      left: 0,
      top: 0,
      width: viewport.width,
      height: viewport.height,
    };
    if (
      r.left >= viewport.width ||
      r.top >= viewport.height ||
      r.left + r.width <= 0 ||
      r.top + r.height <= 0
    )
      throw new Error("关注区域不在视口内，请滚回原位置后重试");
    const left = Math.max(0, Math.floor(r.left * ratioX)),
      top = Math.max(0, Math.floor(r.top * ratioY));
    const width = Math.max(
        1,
        Math.min(bitmap.width, Math.ceil((r.left + r.width) * ratioX)) - left,
      ),
      height = Math.max(
        1,
        Math.min(bitmap.height, Math.ceil((r.top + r.height) * ratioY)) - top,
      );
    const context = new OffscreenCanvas(bitmap.width, bitmap.height),
      ctx = context.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    if (message.noteType !== "page") {
      ctx.strokeStyle = "#2864ef";
      ctx.lineWidth = Math.max(2, ratioX * 2);
      ctx.strokeRect(left + 1, top + 1, width - 2, height - 2);
    }
    const asset = {
      viewport: await imageData(
        await context.convertToBlob({ type: "image/jpeg", quality: 0.88 }),
      ),
      width: bitmap.width,
      height: bitmap.height,
      capturedAt: new Date().toISOString(),
    };
    if (message.noteType !== "page") {
      const crop = new OffscreenCanvas(width, height);
      crop
        .getContext("2d")
        .drawImage(bitmap, left, top, width, height, 0, 0, width, height);
      asset.cropWidth = width;
      asset.cropHeight = height;
      asset.crop = await imageData(
        await crop.convertToBlob({ type: "image/png" }),
      );
    }
    return asset;
  } finally {
    bitmap.close();
  }
}
async function handle(message, sender) {
  if (
    !message ||
    typeof message.type !== "string" ||
    sender.id !== chrome.runtime.id
  )
    throw new Error("无效请求");
  if (message.type === "PANEL_AUTHORIZE")
    return authorizePanel(message.channel, sender);
  if (
    sender.url === chrome.runtime.getURL("offscreen.html") &&
    message.type === "RECORD_EVENT"
  )
    return PageReviewRecorder.event(message);
  const ownUrl = librarySender(sender) ? null : pageSenderUrl(sender);
  const ownPage = ownUrl && Core.pageKey(ownUrl);
  if (["RECORD_START", "RECORD_STOP", "RECORD_CANCEL"].includes(message.type)) {
    if (!ownUrl) throw new Error("此页面不能调用网页评注");
    return PageReviewRecorder.command(message, { ...sender, url: ownUrl });
  }
  if (["GET_RECORD_DRAFT", "DELETE_RECORD_DRAFT"].includes(message.type)) {
    if (!ownUrl) throw new Error("此页面不能调用网页评注");
    const draft = await DB.draft(message.id);
    if (
      !draft ||
      Core.pageKey(draft.pageUrl) !== ownPage ||
      draft.tabId !== sender.tab.id
    )
      throw Error("录制草稿不属于本页");
    if (message.type === "DELETE_RECORD_DRAFT") {
      await DB.deleteDraft(message.id);
      return true;
    }
    return draft.asset;
  }
  if (message.type === "COPY_TEXT") {
    if (typeof message.text !== "string" || message.text.length > 16000)
      throw Error("复制内容无效");
    return PageReviewRecorder.copy(message.text);
  }
  if (message.type === "CREATE_HANDOFF") {
    const page = ownPage || Core.pageKey(message.pageUrl);
    return Cloud.handoff(page);
  }
  if (message.type.startsWith("CLOUD_")) {
    if (
      !Cloud ||
      (ownPage &&
        !["CLOUD_STATUS", "CLOUD_SETUP", "CLOUD_LOGIN", "CLOUD_SYNC"].includes(
          message.type,
        ))
    )
      throw new Error("云空间操作仅允许从保存库发起");
    switch (message.type) {
      case "CLOUD_LIBRARY":
        return Cloud.refreshLibrary(message.filters);
      case "CLOUD_SETUP":
        return Cloud.setup();
      case "CLOUD_LOGIN":
        return Cloud.login({ ...message, sourceTab: sender.tab ||
          (await chrome.tabs.query({ active: true, currentWindow: true }))[0] });
      case "CLOUD_STATUS":
        return Cloud.status();
      case "CLOUD_CONNECT":
        await Cloud.connect(message);
        return Cloud.sync();
      case "CLOUD_SYNC":
        return Cloud.sync();
      case "CLOUD_DISCONNECT":
        return Cloud.disconnect();
      case "CLOUD_CONNECTIONS":
        return Cloud.connections();
      case "CLOUD_CREATE_CONNECTION":
        return Cloud.createConnection(message.name);
      case "CLOUD_REVOKE":
        return Cloud.revoke(message.id);
      case "CLOUD_REMOTE":
        try {
          return await Cloud.remote(message.id);
        } catch (error) {
          if (error.status !== 404) throw error;
          return {
            id: message.id,
            deleted: true,
            note: { comment: "云端记录已删除或不再可读" },
          };
        }
      case "CLOUD_RESTORE_DELETED":
        return Cloud.restoreDeleted(message.id);
      case "CLOUD_FORK":
        return Cloud.fork(message.id);
      default:
        throw new Error("未知云空间操作");
    }
  }
  if (["SAVE", "REBIND", "SET_OUTCOME", "DELETE"].includes(message.type)) {
    const id = message.type === "SAVE" ? message.note?.id : message.id;
    const existing = id ? await DB.get(id) : null;
    const workspace = await cloudWorkspace();
    if (existing?.cloud?.workspaceId && workspace &&
        existing.cloud.workspaceId !== workspace)
      throw Object.assign(new Error("请登录保存这些评注的账号"), {
        code: "account_mismatch",
      });
  }
  switch (message.type) {
    case "GET_SETTINGS":
      return settings();
    case "PANEL_BIND": {
      if (!ownUrl || !(await settings()).enabled)
        throw Error("无法打开私有评注面板");
      const now = Date.now();
      for (const [id, binding] of panelBindings)
        if (binding.expires <= now) panelBindings.delete(id);
      const channel = crypto.randomUUID();
      panelBindings.set(sender.tab.id, { channel, expires: now + 20000 });
      return channel;
    }
    case "ONLINE":
      syncCloud();
      return true;
    case "DISABLE":
      return setEnabled(false);
    case "SAVE_DOCK": {
      const bottom = Number(message.dock?.bottom);
      if (!Number.isFinite(bottom)) throw new Error("位置无效");
      await chrome.storage.local.set({
        dock: {
          side: message.dock.side === "left" ? "left" : "right",
          bottom: Math.max(16, Math.min(bottom, 2000)),
        },
      });
      return true;
    }
    case "OPEN_LIBRARY":
      await chrome.tabs.create({ url: chrome.runtime.getURL("library.html") });
      return true;
    case "REFRESH_PAGE":
      if (!ownPage) throw Error("请从原网页刷新");
      return Cloud.refreshPage(ownPage);
    case "LIST":
      return DB.list(ownPage || undefined);
    case "GET_ASSET": {
      const note = await DB.get(message.id);
      if (!note || (ownPage && note.pageId !== ownPage))
        throw new Error("找不到本页记录");
      return (
        (await DB.asset(note.id)) || (note.hasImage ? Cloud.asset(note) : null)
      );
    }
    case "CAPTURE":
      return capture(message, sender.tab?.id, ownUrl);
    case "SAVE": {
      if (!(await settings()).enabled && ownPage)
        throw new Error("网页评注已关闭，内容仍在输入框中");
      const input = Core.safeNote(message.note);
      if (ownPage && input.pageId !== ownPage)
        throw new Error("不能从本页写入其他网页");
      const existing = input.id ? await DB.get(input.id) : null;
      if (input.id && !existing) throw new Error("原记录不存在，请重新打开");
      if (existing && ownPage && existing.pageId !== ownPage)
        throw new Error("不能修改其他网页的记录");
      if (existing && message.revision !== existing.revision)
        throw new Error("这条评注已在别处更新，请重新打开后编辑");
      const timestamp = new Date().toISOString();
      // Editing changes the comment, not its historic screenshot or anchor.
      if (existing)
        return DB.patch(
          existing.id,
          (current) => {
            if (ownPage && current.pageId !== ownPage)
              throw new Error("不能修改其他网页的记录");
            if (message.revision !== current.revision)
              throw new Error("这条评注已在别处更新，请重新打开后编辑");
            return {
              ...current,
              comment: input.comment,
              feedback: input.feedback,
              kind: input.kind,
              originalComment: current.originalComment ?? current.comment,
              history: [
                ...(current.history || []),
                {
                  comment: current.comment,
                  feedback: current.feedback ?? null,
                  kind: current.kind,
                  at: timestamp,
                },
              ],
              updatedAt: timestamp,
              revision: current.revision + 1,
            };
          },
          await cloudWorkspace(),
        );
      let recordingDraft;
      if (message.recordingId) {
        recordingDraft = await DB.draft(message.recordingId);
        if (
          !recordingDraft ||
          !ownPage ||
          Core.pageKey(recordingDraft.pageUrl) !== ownPage ||
          recordingDraft.tabId !== sender.tab.id
        )
          throw Error("录制草稿不属于本页");
      }
      const image = recordingDraft?.asset || message.asset;
      const note = {
        ...input,
        ...(recordingDraft
          ? {
              hasVideo: true,
              mediaType: "video",
              recording: image.recording,
              capturedAt: image.capturedAt,
            }
          : {}),
        id: crypto.randomUUID(),
        createdAt: timestamp,
        updatedAt: timestamp,
        originalComment: input.comment,
        revision: 1,
        locationStatus: "found",
        hasImage: Boolean(image),
      };
      if (
        image &&
        (!/^data:image\/jpeg;base64,/.test(image.viewport || "") ||
          JSON.stringify(image).length > (recordingDraft ? 52000000 : 16000000))
      )
        throw new Error("画面过大或格式无效，请重新截图");
      if (!existing && !image && !message.allowWithoutImage)
        throw new Error("截图尚未完成，请重试或明确选择仅保存文字");
      const saved = await DB.save(note, image, await cloudWorkspace());
      if (recordingDraft) await DB.deleteDraft(message.recordingId);
      return saved;
    }
    case "LOCATION_RESULTS": {
      if (!ownPage || !Array.isArray(message.results)) return false;
      for (const item of message.results.slice(0, 500)) {
        if (!["found", "uncertain", "missing", "changed"].includes(item.status))
          continue;
        try {
          await DB.patch(
            item.id,
            (note) =>
              note.pageId === ownPage && note.locationStatus !== item.status
                ? {
                    ...note,
                    locationStatus: item.status,
                    checkedAt: new Date().toISOString(),
                  }
                : null,
            undefined,
            { localOnly: true },
          );
        } catch (error) {
          if (!(await DB.get(item.id))) continue;
          throw error;
        }
      }
      return true;
    }
    case "REBIND": {
      return DB.patch(
        message.id,
        (note) => {
          if (note.pageId !== ownPage) throw new Error("找不到本页记录");
          return {
            ...note,
            anchor: message.anchor,
            region: null,
            type: "element",
            pageSignature: String(message.pageSignature || "").slice(0, 6000),
            locationStatus: "found",
            reboundAt: new Date().toISOString(),
            revision: note.revision + 1,
            originalAnchor: note.originalAnchor || note.anchor,
          };
        },
        await cloudWorkspace(),
      );
    }
    case "SET_OUTCOME": {
      if (
        !librarySender(sender) ||
        !["pending", "adopted", "rejected"].includes(message.status)
      )
        throw new Error("结果状态无效");
      return DB.patch(
        message.id,
        (note) => ({
          ...note,
          outcome: {
            status: message.status,
            reason: String(message.reason || "").slice(0, 4000),
            updatedAt: new Date().toISOString(),
          },
          revision: note.revision + 1,
        }),
        await cloudWorkspace(),
      );
    }
    case "DELETE": {
      const existing = await DB.get(message.id);
      if (!existing || (ownPage && existing.pageId !== ownPage))
        throw Error("找不到本页记录");
      await DB.remove(message.id, await cloudWorkspace());
      return true;
    }
    case "OPEN_NOTE": {
      if (!librarySender(sender)) throw new Error("请从保存库打开原网页");
      const note = await DB.get(message.id);
      if (!note) throw new Error("记录不存在");
      const tab = await chrome.tabs.create({ url: note.url });
      await chrome.storage.session.set({ ["focus:" + tab.id]: note.id });
      return true;
    }
    case "TAKE_FOCUS": {
      if (!ownUrl) throw new Error("此页面不能调用网页评注");
      const key = "focus:" + sender.tab.id;
      const entry = await chrome.storage.session.get(key);
      await chrome.storage.session.remove(key);
      return entry[key] || null;
    }
    default:
      throw new Error("不支持的操作");
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target === "offscreen") return;
  handle(message, sender).then(
    (value) => {
      respond({ ok: true, value });
      if (["SAVE", "REBIND", "SET_OUTCOME", "DELETE"].includes(message.type))
        syncCloud(value?.pageId || (librarySender(sender)
          ? undefined
          : Core.pageKey(pageSenderUrl(sender))));
    },
    (error) => respond({ ok: false, error: error.message || "操作失败", code: error.code }),
  );
  return true;
});
