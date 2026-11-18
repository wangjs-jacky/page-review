(function () {
  "use strict";
  const app = document.getElementById("app"),
    detail = document.getElementById("detail-dialog"),
    access = document.getElementById("access-dialog"),
    deletion = document.getElementById("delete-dialog"),
    error = document.getElementById("history-error");
  const esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const icons = {
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    like: '<path d="M7 10v11H3V10h4Zm0 0 5-7c1-1 3 0 3 2l-1 5h5a2 2 0 0 1 2 2l-2 7a3 3 0 0 1-3 2H7"/>',
    dislike:
      '<path d="M7 14V3H3v11h4Zm0 0 5 7c1 1 3 0 3-2l-1-5h5a2 2 0 0 0 2-2l-2-7a3 3 0 0 0-3-2H7"/>',
    note: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6"/>',
  };
  const icon = (n) =>
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[n] || icons.note}</svg>`,
    clock = (s) =>
      Math.floor((s || 0) / 60) +
      ":" +
      String(Math.floor((s || 0) % 60)).padStart(2, "0"),
    time = (t) =>
      new Date(t).toLocaleString("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
    feedback = (n) =>
      n.feedback
        ? `<span class="feedback ${n.feedback}" aria-label="${n.feedback === "positive" ? "点赞" : "点踩"}">${icon(n.feedback === "positive" ? "like" : "dislike")}</span>`
        : "";
  const state = {
    notes: [],
    cloud: {},
    query: "",
    date: "all",
    from: "",
    to: "",
    selected: null,
    editing: false,
    editingFeedback: null,
    busy: false,
    deleting: null,
    picture: false,
    remote: null,
  };
  const assets = new Map();
  let toastTimer;
  async function send(type, payload = {}) {
    const r = await chrome.runtime.sendMessage({ type, ...payload });
    if (!r?.ok) throw Error(r?.error || "操作失败");
    return r.value;
  }
  function toast(text) {
    const el = document.getElementById("toast");
    clearTimeout(toastTimer);
    el.textContent = text;
    el.classList.add("visible");
    toastTimer = setTimeout(() => el.classList.remove("visible"), 4000);
  }
  function range() {
    if (state.date === "custom") {
      if (
        state.from &&
        state.to &&
        Date.parse(state.from) > Date.parse(state.to)
      )
        throw Error("结束时间早于开始时间");
      return {
        from: state.from ? new Date(state.from).toISOString() : null,
        to: state.to ? new Date(state.to).toISOString() : null,
      };
    }
    if (state.date === "all") return {};
    const now = new Date(),
      from = new Date(now);
    from.setHours(0, 0, 0, 0);
    if (state.date === "week") from.setDate(from.getDate() - 6);
    return { from: from.toISOString(), to: now.toISOString() };
  }
  function visible() {
    let r;
    try {
      r = range();
    } catch {
      return [];
    }
    return state.notes.filter(
      (n) =>
        (!r.from || n.createdAt >= r.from) &&
        (!r.to || n.createdAt <= r.to) &&
        (!state.query ||
          [n.title, n.url, n.comment]
            .join(" ")
            .toLowerCase()
            .includes(state.query.toLowerCase())),
    );
  }
  function render() {
    const rows = visible();
    document.getElementById("count").textContent = rows.length + " 条评注";
    app.innerHTML = rows.length
      ? rows
          .map(
            (n) =>
              `<button class="history-row" data-action="detail" data-id="${n.id}">${n.hasImage ? `<img data-image="${n.id}" alt="${n.hasVideo ? "录制封面" : "截图"}">` : `<span class="no-media">${icon("note")}</span>`}<span class="history-content"><strong>${esc(n.title || new URL(n.url).hostname)}${n.hasVideo ? `<b class="video-flag">▶ ${clock(n.recording?.duration)}</b>` : ""}</strong><span class="row-comment">${feedback(n)}${esc(n.comment)}</span></span><time>${time(n.createdAt)}</time></button>`,
          )
          .join("")
      : '<div class="empty-state">没有匹配的评注</div>';
    images(app);
  }
  async function image(id) {
    if (!assets.has(id)) assets.set(id, await send("GET_ASSET", { id }));
    return assets.get(id);
  }
  async function images(container) {
    for (const el of container.querySelectorAll("[data-image]"))
      try {
        const a = await image(el.dataset.image);
        if (el.isConnected && a?.viewport) el.src = a.viewport;
      } catch {
        el.alt = "附件暂不可用";
      }
  }
  async function reload({ remote = false } = {}) {
    error.hidden = true;
    if (remote)
      try {
        await send("CLOUD_LIBRARY", { filters: range() });
      } catch (e) {
        error.textContent = e.message;
        error.hidden = false;
      }
    [state.notes, state.cloud] = await Promise.all([
      send("LIST"),
      send("CLOUD_STATUS"),
    ]);
    render();
  }
  const head = (title) =>
    `<header class="modal-head"><h2>${title}</h2><button class="icon-btn" data-action="close-${title === "连接设置" ? "settings" : "detail"}" aria-label="关闭${title}">${icon("close")}</button></header>`;
  async function showDetail() {
    const n = state.notes.find((n) => n.id === state.selected);
    if (!n) {
      detail.close();
      return;
    }
    let a = assets.get(n.id);
    detail.innerHTML =
      head("评注详情") +
      `<div class="detail-body"><div class="detail-source"><button class="text-button" data-action="open">${esc(new URL(n.url).hostname)}</button><time>${time(n.createdAt)}</time></div>${state.editing ? `<textarea id="edit-comment" aria-label="修改评注" maxlength="12000">${esc(n.comment)}</textarea><div class="detail-actions">${["positive", "negative"].map((v) => `<button class="icon-btn" data-action="feedback" data-value="${v}" aria-label="${v === "positive" ? "点赞" : "点踩"}" aria-pressed="${state.editingFeedback === v}">${icon(v === "positive" ? "like" : "dislike")}</button>`).join("")}<button class="btn" data-action="cancel-edit">取消</button><button class="btn primary" data-action="save-edit">保存</button></div>` : `${feedback(n)}<p class="detail-comment">${esc(n.comment)}</p><div class="detail-actions"><button class="text-button" data-action="edit">修改</button><button class="text-button" data-action="delete">删除</button>${n.cloud?.status === "conflict" ? '<button class="text-button" data-action="conflict">处理同步冲突</button>' : ""}</div>`}${n.hasImage ? '<div id="detail-media" class="detail-media"></div>' : ""}${state.remote ? `<div class="conflict"><p>云端：${esc(state.remote.note.comment)}</p><button class="btn" data-action="fork">将本机意见另存</button></div>` : ""}</div><footer class="detail-footer"><button class="btn" data-action="open">返回网页</button><button class="btn primary" data-action="copy-page">复制本页评注</button></footer>`;
    if (!detail.open) detail.showModal();
    if (n.hasImage) {
      try {
        a = await image(n.id);
        if (state.selected !== n.id || !detail.open) return;
        const target = document.getElementById("detail-media");
        if (target)
          target.innerHTML = a?.video
            ? `<video controls muted playsinline src="${a.video}" poster="${a.viewport}"></video><div class="keyframes">${a.frames.map((f, i) => `<button data-action="seek" data-index="${i}" aria-label="跳转 ${clock(f.at)}"><img src="${f.data}" alt=""><time>${clock(f.at)}</time></button>`).join("")}</div>`
            : a?.viewport
              ? `<button class="image-preview" data-action="enlarge" aria-label="放大截图"><img src="${a.viewport}" alt="截图"></button>`
              : "";
      } catch (e) {
        const target = document.getElementById("detail-media");
        if (target)
          target.innerHTML = `<p class="inline-error">${esc(e.message)}</p><button class="text-button" data-action="retry-media">重试</button>`;
      }
    }
  }
  function renderSettings() {
    const c = state.cloud,
      connected = c.configured,
      ready = c.cliConnections?.length,
      cap = c.capabilities;
    const deleted = (c.pending || []).filter(
      (n) => n.kind === "delete" && n.conflict,
    );
    access.innerHTML =
      head("连接设置") +
      `<div class="settings-body">${!connected ? '<button class="btn primary" data-action="login">登录账号</button>' : `<div class="account-row"><strong>${esc(c.name || "已登录")}</strong><button class="text-button" data-action="logout">退出</button></div>${ready ? c.cliConnections.map((n) => `<div class="connection"><div><strong>${esc(n.device_name)}</strong><span>已连接</span></div><button class="text-button" data-action="revoke" data-id="${n.id}">撤销</button></div>`).join("") : cap?.cliAvailable && cap?.terminalConnect === 1 ? '<button class="btn primary" data-action="copy-install">复制 macOS 安装命令</button><button class="btn" data-action="copy-login">连接终端 · 复制命令</button>' : `<p class="muted">${cap ? "终端连接组件需要更新" : "服务需要更新，暂不能连接终端"}</p>`}<button class="text-button" data-action="check">检查连接</button>${c.pending?.length ? `<div class="sync-error"><span>${c.pending.length} 条待同步</span><button class="text-button" data-action="sync">重试同步</button></div>` : ""}`}${deleted.map((n) => `<div class="sync-error"><span>${esc(n.localComment)}<br>云端记录已有修改</span><button class="text-button" data-action="restore-deleted" data-id="${n.id}">恢复云端记录</button></div>`).join("")}<p id="settings-error" class="inline-error" role="alert"></p></div>`;
  }
  async function settings() {
    if (state.editing) throw Error("请先保存或取消修改");
    state.cloud = await send("CLOUD_SETUP");
    renderSettings();
    if (!access.open) access.showModal();
  }
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      await send("COPY_TEXT", { text });
    }
    toast("已复制");
  }
  async function act(b) {
    const a = b.dataset.action,
      n = state.notes.find((n) => n.id === state.selected);
    if (a === "settings") {
      await settings();
      return;
    }
    if (a === "close-settings") {
      access.close();
      return;
    }
    if (a === "refresh") {
      await reload({ remote: true });
      return;
    }
    if (a === "detail") {
      if (state.editing) throw Error("请先保存或取消修改");
      state.selected = b.dataset.id;
      state.remote = null;
      await showDetail();
      return;
    }
    if (a === "close-detail") {
      if (state.editing) throw Error("请先保存或取消修改");
      detail.close();
      return;
    }
    if (a === "open") return send("OPEN_NOTE", { id: n.id });
    if (a === "edit") {
      state.editing = true;
      state.editingFeedback = n.feedback;
      return showDetail();
    }
    if (a === "cancel-edit") {
      state.editing = false;
      return showDetail();
    }
    if (a === "feedback") {
      state.editingFeedback =
        state.editingFeedback === b.dataset.value ? null : b.dataset.value;
      detail
        .querySelectorAll('[data-action="feedback"]')
        .forEach((el) =>
          el.setAttribute(
            "aria-pressed",
            String(el.dataset.value === state.editingFeedback),
          ),
        );
      return;
    }
    if (a === "save-edit") {
      await send("SAVE", {
        note: {
          ...n,
          comment: document.getElementById("edit-comment").value,
          feedback: state.editingFeedback,
        },
        revision: n.revision,
      });
      state.editing = false;
      await reload();
      await showDetail();
      toast("已保存");
      return;
    }
    if (a === "delete") {
      state.deleting = n.id;
      deletion.showModal();
      return;
    }
    if (a === "keep") {
      deletion.close();
      return;
    }
    if (a === "confirm-delete") {
      await send("DELETE", { id: state.deleting });
      assets.delete(state.deleting);
      deletion.close();
      detail.close();
      await reload();
      toast("已删除");
      return;
    }
    if (a === "enlarge") {
      detail.classList.toggle("media-expanded");
      return;
    }
    if (a === "retry-media") {
      assets.delete(n.id);
      return showDetail();
    }
    if (a === "seek") {
      const video = detail.querySelector("video");
      video.currentTime = assets.get(n.id).frames[Number(b.dataset.index)].at;
      return video.play();
    }
    if (a === "copy-page") {
      const fixed = await send("CREATE_HANDOFF", { pageUrl: n.url });
      await copy(fixed.text);
      return;
    }
    if (a === "conflict") {
      state.remote = await send("CLOUD_REMOTE", { id: n.id });
      return showDetail();
    }
    if (a === "fork") {
      await send("CLOUD_FORK", { id: n.id });
      assets.delete(n.id);
      state.remote = null;
      await reload();
      return showDetail();
    }
    if (a === "login") {
      await send("CLOUD_LOGIN");
      await reload({ remote: true });
      return settings();
    }
    if (a === "logout") {
      await send("CLOUD_DISCONNECT");
      return settings();
    }
    if (a === "restore-deleted") {
      await send("CLOUD_RESTORE_DELETED", { id: b.dataset.id });
      await reload();
      return settings();
    }
    if (a === "sync") {
      await send("CLOUD_SYNC");
      await reload();
      return settings();
    }
    if (a === "check") return settings();
    if (a === "revoke") {
      await send("CLOUD_REVOKE", { id: b.dataset.id });
      return settings();
    }
    if (a === "copy-install")
      return copy(
        "curl -fsSL " + state.cloud.capabilities.installUrl + " | sh",
      );
    if (a === "copy-login")
      return copy("page-review connect --api " + state.cloud.apiUrl + " --workspace " + state.cloud.workspaceId);
  }
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-action]");
    if (!b || state.busy) return;
    state.busy = true;
    b.disabled = true;
    try {
      await act(b);
    } catch (e) {
      toast(e.message);
      if (access.open) {
        const el = document.getElementById("settings-error");
        if (el) el.textContent = e.message;
      }
    } finally {
      state.busy = false;
      if (b.isConnected) b.disabled = false;
    }
  });
  document.getElementById("search").addEventListener("input", (e) => {
    state.query = e.target.value;
    render();
  });
  document
    .getElementById("history-date")
    .addEventListener("change", async (e) => {
      state.date = e.target.value;
      document.getElementById("custom-date").hidden = state.date !== "custom";
      await reload({ remote: true });
    });
  for (const key of ["from", "to"])
    document
      .getElementById("date-" + key)
      .addEventListener("change", async (e) => {
        state[key] = e.target.value;
        await reload({ remote: true });
      });
  detail.addEventListener("cancel", (e) => {
    if (state.editing) {
      e.preventDefault();
      toast("请先保存或取消修改");
    }
  });
  chrome.storage.onChanged?.addListener((changes) => {
    if (changes.cloudSyncResult && !state.busy)
      reload().catch((e) => toast(e.message));
  });
  window.addEventListener("online", () =>
    send("CLOUD_SYNC")
      .then(() => reload())
      .catch((e) => toast(e.message)),
  );
  reload({ remote: true }).catch((e) => {
    app.textContent = e.message;
  });
})();
