/* Event-driven login in an ordinary tab in the invoking browser. No default-browser launch. */
(function (root) {
  "use strict";
  root.PageReviewTabLoginFactory = function ({ chrome, loginOrigin, complete }) {
    const key = "pageReviewLogin", store = chrome.storage.session;
    let waiter, starting = false, completing = false, timeout;
    const read = async () => (await store.get(key))[key];
    async function clear(pending, error, result) {
      const current = await read();
      if (current?.requestId !== pending.requestId) return;
      await store.remove(key);
      clearTimeout(timeout);
      const waiting = waiter; waiter = null;
      // Return first, then close only the tab this login created.
      if (pending.sourceTabId) {
        const tab = await chrome.tabs.get(pending.sourceTabId).catch(() => null);
        if (tab) {
          await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
          if (tab.windowId) await chrome.windows?.update(tab.windowId, { focused: true }).catch(() => {});
          if (!waiting) await chrome.tabs.sendMessage(tab.id, {
            type: "PAGE_REVIEW_LOGIN_RESULT", ok: !error, error: error?.message,
            resume: pending.context.resume,
          }).catch(() => {});
        }
      }
      if (pending.tabId) await chrome.tabs.remove(pending.tabId).catch(() => {});
      if (error) waiting?.reject(error); else waiting?.resolve(result);
    }
    function arm(pending) {
      clearTimeout(timeout);
      // One deadline, never a business-state query loop. Session state survives worker restart.
      timeout = setTimeout(() => clear(pending, Error("登录已过期，请重新登录；本机评注仍保留")).catch(() => {}), Math.max(1, pending.expires - Date.now()));
    }
    async function external(message, sender) {
      const p = await read();
      if (!p || completing) throw Error("请从插件重新开始登录");
      if (p.expires <= Date.now()) { await clear(p, Error("登录已过期")); throw Error("登录已过期"); }
      const u = new URL(sender.url || "about:blank");
      if (u.origin !== loginOrigin || u.pathname !== "/page-review/authorize" ||
          u.searchParams.get("request_id") !== p.requestId || sender.tab?.id !== p.tabId ||
          message.requestId !== p.requestId || sender.frameId !== 0)
        throw Error("登录来源不匹配");
      if (message.type === "PAGE_REVIEW_LOGIN_PROOF") return { proof: p.proof };
      if (message.type !== "PAGE_REVIEW_LOGIN_COMPLETE") throw Error("未知登录请求");
      completing = true;
      clearTimeout(timeout);
      try {
        // complete validates callback state/PKCE and account before writing the connection.
        const result = await complete(p.context, message.callbackUrl);
        await clear(p, null, result);
        return { ok: true };
      } catch (e) { await clear(p, e); throw e; }
      finally { completing = false; }
    }
    chrome.runtime.onMessageExternal.addListener((message, sender, respond) => {
      external(message, sender).then(respond, e => respond({ error: e.message }));
      return true;
    });
    chrome.tabs.onRemoved.addListener(id => {
      read().then(p => { if (p?.tabId === id && !completing) return clear(p, Error("登录已取消，本机评注仍保留")); }).catch(() => {});
    });
    return {
      async launch(create, context, sourceTab) {
        if (starting || completing) throw Error("登录正在进行，请完成当前登录");
        starting = true;
        try {
          const previous = await read();
          if (previous && previous.expires > Date.now()) {
            await chrome.tabs.update(previous.tabId, { active: true }).catch(() => {});
            throw Error("登录正在进行，请完成当前登录");
          }
          if (previous) await clear(previous, Error("登录已过期"));
          const started = await create();
          const target = new URL(started.authorizeUrl);
          if (target.origin !== loginOrigin || target.pathname !== "/page-review/authorize" ||
              target.searchParams.get("request_id") !== started.requestId ||
              !/^[A-Za-z0-9_-]{43}$/.test(started.requestId)) throw Error("登录入口校验失败");
          const tab = await chrome.tabs.create({ url: "about:blank", active: false,
            ...(sourceTab?.windowId ? { windowId: sourceTab.windowId } : {}),
            ...(sourceTab?.id ? { openerTabId: sourceTab.id } : {}),
          });
          const pending = { ...started, context, sourceTabId: sourceTab?.id,
            tabId: tab.id, expires: Date.now() + 5 * 60_000 };
          const result = new Promise((resolve, reject) => { waiter = { resolve, reject }; });
          try {
            await store.set({ [key]: pending }); arm(pending);
            await chrome.tabs.update(tab.id, { url: target.href, active: true });
          } catch (e) {
            if ((await read())?.requestId === pending.requestId) await clear(pending, e);
            else {
              const waiting = waiter; waiter = null;
              await chrome.tabs.remove(tab.id).catch(() => {});
              waiting?.reject(e);
            }
          }
          return result;
        } finally { starting = false; }
      },
    };
  };
})(globalThis);
