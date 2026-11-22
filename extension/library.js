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
  let toastTimer, settingsRequest = 0, reloadRequest = 0;
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
  function pageGroups(rows) {
    const domains = new Map();
    for (const note of rows) {
      const url = new URL(note.pageId || PageReviewCore.pageKey(note.url));
      const domain = url.hostname;
      if (!domains.has(domain)) domains.set(domain, new Map());
      const pages = domains.get(domain);
      if (!pages.has(url.href)) {
        pages.set(url.href, { url, title: note.title || url.hostname, notes: [] });
      }
      pages.get(url.href).notes.push(note);
    }
    return domains;
  }
  function thumbnail(notes, kind) {
    const ids = notes.filter((note) => note.hasImage).map((note) => note.id);
    return `<span class="history-cover" data-kind="${kind}" data-images="${esc(JSON.stringify(ids))}">${icon("note")}<img alt="" hidden></span>`;
  }
  function render() {
    const rows = visible();
    const domains = pageGroups(rows);
    const selectedPage = history.state?.annotationPage;
    const page = selectedPage &&
      pageGroups(state.notes.filter((note) =>
        (note.pageId || PageReviewCore.pageKey(note.url)) === selectedPage,
      )).get(new URL(selectedPage).hostname)?.get(selectedPage);
    const matchingPage = page && domains.get(page.url.hostname)?.get(selectedPage);
    document.getElementById("count").textContent =
      (page ? matchingPage?.notes.length || 0 : rows.length) + " 条评注";
    if (page) {
      app.innerHTML = `<div class="history-page-heading">
        <button class="text-button history-back" data-action="back-page">‹ 返回网页</button>
        <span>${esc(page.url.hostname)}</span>
        <h1>${esc(page.title)}</h1>
      </div>${matchingPage ? `<div class="history-grid">${matchingPage.notes.map((note) =>
        `<button class="history-card note-card" data-action="detail" data-id="${esc(note.id)}">${thumbnail([note], "note")}
          <span class="card-copy"><span class="note-caption">${feedback(note)}${esc(note.comment) || "评注"}</span>
          <span class="card-meta"><time>${time(note.createdAt)}</time>${note.hasVideo ? `<b class="video-flag">▶ ${clock(note.recording?.duration)}</b>` : ""}</span></span>
        </button>`).join("")}</div>` : '<div class="empty-state">没有匹配的评注</div>'}`;
    } else {
      if (selectedPage) history.replaceState(null, "");
      app.innerHTML = domains.size ? [...domains].map(([domain, pages]) =>
        `<section class="history-domain"><header><h2>${esc(domain)}</h2><span>${pages.size} 个网页</span></header>
          <div class="history-grid">${[...pages].map(([key, item]) =>
            `<article class="history-card page-card"><button class="page-card-open" data-action="view-page" data-page="${esc(key)}">${thumbnail(item.notes, "page")}
              <span class="card-copy"><span class="card-title"><strong>${esc(item.title)}</strong><span class="card-count">${item.notes.length} 条评注</span></span>
              <span class="card-meta card-path">${esc(item.url.pathname + item.url.search + item.url.hash)}</span></span>
            </button><div class="page-card-actions">
              <button class="btn" data-action="copy-page" data-page="${esc(key)}" aria-label="复制 ${esc(item.title)} 的全部评注">复制评注</button>
              <button class="text-button card-delete" data-action="delete-page" data-page="${esc(key)}" aria-label="删除 ${esc(item.title)} 的全部评注">删除本页评注</button>
            </div></article>`).join("")}</div>
        </section>`).join("") : '<div class="empty-state">没有匹配的评注</div>';
    }
    thumbnails(app);
  }
  async function image(id) {
    if (!assets.has(id)) {
      const pending = send("GET_ASSET", { id }).catch((error) => {
        if (assets.get(id) === pending) assets.delete(id);
        throw error;
      });
      assets.set(id, pending);
    }
    return assets.get(id);
  }
  async function thumbnails(container) {
    for (const frame of container.querySelectorAll("[data-images]")) {
      for (const id of JSON.parse(frame.dataset.images)) {
        if (!frame.isConnected) return;
        try {
          const asset = await image(id);
          const src = frame.dataset.kind === "note"
            ? asset?.crop || asset?.viewport
            : asset?.viewport;
          if (!src) continue;
          const img = frame.querySelector("img");
          img.src = src;
          await img.decode();
          if (!frame.isConnected) return;
          img.hidden = false;
          frame.querySelector("svg").remove();
          break;
        } catch {
          // An older attachment can be unavailable. Try the next cover.
        }
      }
    }
  }
  async function reload({ remote = false } = {}) {
    const request = ++reloadRequest;
    error.hidden = true;
    if (remote)
      try {
        await send("CLOUD_LIBRARY", { filters: range() });
      } catch (e) {
        if (request === reloadRequest) {
          error.textContent = e.message;
          error.hidden = false;
        }
      }
    const [notes, cloud] = await Promise.all([
      send("LIST"),
      send("CLOUD_STATUS"),
    ]);
    if (request !== reloadRequest) return;
    state.notes = notes;
    state.cloud = cloud;
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
    let a;
    detail.innerHTML =
      head("评注详情") +
      `<div class="detail-body"><div class="detail-source"><button class="text-button" data-action="open">${esc(new URL(n.url).hostname)}</button><time>${time(n.createdAt)}</time></div>${state.editing ? `<textarea id="edit-comment" aria-label="修改评注" maxlength="12000">${esc(n.comment)}</textarea><div class="detail-actions">${["positive", "negative"].map((v) => `<button class="icon-btn" data-action="feedback" data-value="${v}" aria-label="${v === "positive" ? "点赞" : "点踩"}" aria-pressed="${state.editingFeedback === v}">${icon(v === "positive" ? "like" : "dislike")}</button>`).join("")}<button class="btn" data-action="cancel-edit">取消</button><button class="btn primary" data-action="save-edit">保存</button></div>` : `${feedback(n)}<p class="detail-comment">${esc(n.comment)}</p><div class="detail-actions"><button class="text-button" data-action="edit">修改</button><button class="text-button" data-action="delete">删除</button>${n.cloud?.status === "conflict" ? '<button class="text-button" data-action="conflict">处理同步冲突</button>' : ""}</div>`}${n.hasImage ? '<div id="detail-media" class="detail-media"></div>' : ""}${state.remote ? `<div class="conflict"><p>云端：${esc(state.remote.note.comment)}</p><button class="btn" data-action="fork">将本机意见另存</button></div>` : ""}</div><footer class="detail-footer"><button class="btn" data-action="open">返回网页</button><button class="btn" data-action="copy-page-full">复制完整指令</button><button class="btn primary" data-action="copy-page">复制本页评注</button></footer>`;
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
    const request = ++settingsRequest;
    access.innerHTML = head("连接设置") +
      '<div class="settings-body"><p class="muted" role="status">正在读取连接状态…</p></div>';
    if (!access.open) access.showModal();
    try {
      const cloud = await send("CLOUD_SETUP");
      if (request !== settingsRequest || !access.open) return;
      state.cloud = cloud;
      renderSettings();
    } catch (error) {
      if (request !== settingsRequest || !access.open) return;
      access.innerHTML = head("连接设置") +
        `<div class="settings-body"><p class="inline-error" role="alert">${esc(error.message)}</p><button class="btn" data-action="check">重试</button></div>`;
    }
  }
  async function copy(text, pending = false) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      await send("COPY_TEXT", { text });
    }
    toast(pending ? "已复制，最新评注正在同步" : "已复制");
  }
  async function act(b) {
    const a = b.dataset.action,
      n = state.notes.find((n) => n.id === state.selected);
    if (a === "refresh") {
      await reload({ remote: true });
      return;
    }
    if (a === "view-page") {
      history.pushState({ annotationPage: b.dataset.page }, "");
      render();
      window.scrollTo(0, 0);
      return;
    }
    if (a === "back-page") {
      history.back();
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
    if (a === "delete" || a === "delete-page") {
      const pageUrl = b.dataset.page;
      const page = pageUrl && pageGroups(state.notes)
        .get(new URL(pageUrl).hostname)?.get(pageUrl);
      const notes = pageUrl ? page?.notes : n && [n];
      if (!notes?.length) throw Error("找不到要删除的评注");
      state.deleting = notes.map((note) => note.id);
      document.getElementById("delete-heading").textContent = page
        ? "删除此网页的全部评注？" : "删除这条评注？";
      document.getElementById("delete-scope").textContent = page
        ? `${page.title} · ${page.url.pathname}${page.url.search}${page.url.hash}，共 ${notes.length} 条评注（含当前筛选条件之外的评注）。`
        : "";
      deletion.showModal();
      return;
    }
    if (a === "keep") {
      deletion.close();
      return;
    }
    if (a === "confirm-delete") {
      const ids = state.deleting;
      const failed = [];
      const progress = document.getElementById("delete-progress");
      progress.textContent = `正在删除 ${ids.length} 条评注…`;
      for (const id of ids) {
        try {
          await send("DELETE", { id });
          assets.delete(id);
        } catch {
          failed.push(id);
        }
      }
      deletion.close();
      if (detail.open && !failed.includes(state.selected)) detail.close();
      await reload();
      toast(failed.length
        ? `已删除 ${ids.length - failed.length} 条，${failed.length} 条未删除，可重试`
        : `已删除 ${ids.length} 条评注`);
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
      video.currentTime = (await image(n.id)).frames[Number(b.dataset.index)].at;
      return video.play();
    }
    if (a === "copy-page" || a === "copy-page-full") {
      const fixed = await send("GET_PAGE_REFERENCE", { pageUrl: b.dataset.page || n.url });
      await copy(a === "copy-page-full" ? fixed.text : fixed.reference, fixed.pending);
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
    if (!b) return;
    if (b.dataset.action === "close-settings") {
      access.close();
      return;
    }
    if (b.dataset.action === "settings") {
      if (!access.open) settings().catch((error) => toast(error.message));
      return;
    }
    if (state.busy) return;
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
  window.addEventListener("popstate", render);
  document.getElementById("search").addEventListener("input", (e) => {
    state.query = e.target.value;
    render();
  });
  const dateTrigger = document.getElementById("history-date");
  const dateMenu = document.getElementById("date-menu");
  const dateOptions = [...dateMenu.querySelectorAll("[data-range]")];

  function closeDateMenu({ restoreFocus = false } = {}) {
    dateMenu.hidden = true;
    dateTrigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) dateTrigger.focus();
  }

  function openDateMenu(option = dateOptions.find((item) => item.dataset.range === state.date)) {
    dateMenu.hidden = false;
    dateTrigger.setAttribute("aria-expanded", "true");
    option.focus();
  }

  function refreshDateFilter() {
    render();
    reload({ remote: true }).catch((error) => toast(error.message));
  }

  dateTrigger.addEventListener("click", () => {
    if (dateMenu.hidden) openDateMenu();
    else closeDateMenu();
  });
  dateTrigger.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    openDateMenu(event.key === "ArrowDown" ? dateOptions[0] : dateOptions.at(-1));
  });
  dateMenu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDateMenu({ restoreFocus: true });
      return;
    }
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = dateOptions.indexOf(document.activeElement);
    const offset = event.key === "ArrowUp" ? -1 : 1;
    const next = event.key === "Home" ? 0 : event.key === "End" ? dateOptions.length - 1
      : (index + offset + dateOptions.length) % dateOptions.length;
    dateOptions[next].focus();
  });
  dateMenu.addEventListener("click", (event) => {
    const option = event.target.closest("[data-range]");
    if (!option) return;
    state.date = option.dataset.range;
    dateTrigger.firstElementChild.textContent = option.textContent;
    for (const item of dateOptions) item.setAttribute("aria-checked", String(item === option));
    document.getElementById("custom-date").hidden = state.date !== "custom";
    closeDateMenu({ restoreFocus: true });
    refreshDateFilter();
  });
  const dateFilter = dateTrigger.parentElement;
  document.addEventListener("pointerdown", (event) => {
    if (!dateMenu.hidden && !dateFilter.contains(event.target)) closeDateMenu();
  });
  dateFilter.addEventListener("focusout", (event) => {
    if (!dateMenu.hidden && !dateFilter.contains(event.relatedTarget)) closeDateMenu();
  });
  for (const key of ["from", "to"]) {
    document.getElementById("date-" + key).addEventListener("change", (event) => {
      state[key] = event.target.value;
      refreshDateFilter();
    });
  }
  deletion.addEventListener("cancel", (event) => {
    if (state.busy) event.preventDefault();
  });
  deletion.addEventListener("close", () => {
    state.deleting = null;
    document.getElementById("delete-progress").textContent = "";
  });
  access.addEventListener("close", () => {
    if (!access.open) settingsRequest++;
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
