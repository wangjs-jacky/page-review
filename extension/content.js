(function () {
  "use strict";
  if (globalThis.__pageReviewController) {
    globalThis.__pageReviewController.refresh();
    return;
  }
  const Core = PageReviewCore;
  const I = {
    like: '<path d="M7 10v11H3V10h4Zm0 0 5-7c1-1 3 0 3 2l-1 5h5a2 2 0 0 1 2 2l-2 7a3 3 0 0 1-3 2H7"/>',
    dislike:
      '<path d="M7 14V3H3v11h4Zm0 0 5 7c1 1 3 0 3-2l-1-5h5a2 2 0 0 0 2-2l-2-7a3 3 0 0 0-3-2H7"/>',
    select:
      '<path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m8-5 3 7 2-4 4-2-7-3Z"/>',
    hide: '<path d="m3 3 18 18M9.5 5.3A12 12 0 0 1 12 5c6 0 10 7 10 7a20 20 0 0 1-4 4M6 6a22 22 0 0 0-4 6s4 7 10 7a12 12 0 0 0 5-1M10 10a3 3 0 0 0 4 4"/>',
    pin: '<path d="M19 10c0 5-7 11-7 11s-7-6-7-11a7 7 0 0 1 14 0Z"/><circle cx="12" cy="10" r="2"/>',
    pen: '<path d="m16 3 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L3 16l-1 6Z"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    area: '<rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="3 3"/>',
    page: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a20 20 0 0 0 0 18 20 20 0 0 0 0-18Z"/>',
    note: '<path d="M4 3h16v14l-4 4H4Zm12 14v4M8 8h8M8 12h6"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    book: '<path d="M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4Zm16 0h-5a3 3 0 0 0-2 3v14a4 4 0 0 1 4-2h3Z"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    image:
      '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m3 17 6-6 4 4 3-3 5 5"/><circle cx="8" cy="8" r="1"/>',
    settings:
      '<path d="M4 7h8m4 0h4M4 17h4m4 0h8"/><circle cx="14" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
    record:
      '<rect x="3" y="5" width="13" height="14" rx="3"/><path d="m16 9 5-3v12l-5-3"/>',
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"/>',
    history: '<path d="M3 10a9 9 0 1 1 2 8M3 4v6h6m3-3v6l4 2"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  };
  const icon = (name) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[name] || I.note}</svg>`;
  const esc = (value) =>
    String(value ?? "").replace(
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
  const labels = {
    found: "已定位",
    uncertain: "位置待确认",
    missing: "原位置失效",
    changed: "页面已明显变化",
  };
  let host,
    shadow,
    privatePanel,
    controller,
    observer,
    observerTimer,
    frame,
    toastTimer,
    drag,
    regionDrag,
    regionCursorSheet,
    suppressClick = 0,
    operation = 0,
    route = location.href;
    state.recordSeed = null;
  const state = {
    cloud: null,
    copying: false,
    copyIssue: null,
    copyFormat: "reference",
    copyResumePanel: null,
    record: null,
    mediaBack: null,
    confirm: null,
    pageError: "",
    enabled: false,
    dock: { side: "right", bottom: 24 },
    notes: [],
    matches: new Map(),
    mode: "browse",
    panel: null,
    showMarkers: true,
    hover: null,
    draft: null,
    peek: null,
    busy: false,
    rebind: null,
  };
  async function send(type, payload = {}) {
    const result = await chrome.runtime.sendMessage({ type, ...payload });
    if (!result?.ok)
      throw Object.assign(new Error(result?.error || "插件已更新，请刷新网页后继续"), {
        code: result?.code,
      });
    return result.value;
  }
  const own = (event) => Boolean(host && event.composedPath().includes(host));
  function textOf(el, length = 1200) {
    if (!el || /^(INPUT|TEXTAREA|SELECT|SCRIPT|STYLE)$/.test(el.tagName))
      return "";
    return Core.normalize(el.innerText || el.textContent).slice(0, length);
  }
  function signature() {
    return textOf(
      document.querySelector('main,[role="main"],article') || document.body,
      6000,
    );
  }
  function selectorFor(el) {
    const parts = [];
    let current = el;
    while (
      current &&
      current !== document.documentElement &&
      parts.length < 6
    ) {
      if (current.id && !/\d{3}|[a-f\d]{10}/i.test(current.id)) {
        parts.unshift("#" + CSS.escape(current.id));
        break;
      }
      const testId = current.getAttribute("data-testid");
      if (testId) {
        parts.unshift(`[data-testid="${CSS.escape(testId)}"]`);
        break;
      }
      let part = current.localName;
      if (!part) break;
      const siblings = current.parentElement
        ? [...current.parentElement.children].filter(
            (e) => e.localName === current.localName,
          )
        : [];
      if (siblings.length > 1)
        part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(" > ");
  }
  function descriptor(el) {
    const attrs = {};
    for (const key of [
      "id",
      "data-testid",
      "aria-label",
      "role",
      "href",
      "alt",
    ]) {
      const value = el.getAttribute(key);
      if (value && !(key === "id" && /\d{3}|[a-f\d]{10}/i.test(value)))
        attrs[key] = value.slice(0, 300);
    }
    const r = el.getBoundingClientRect();
    return {
      tag: el.localName,
      selector: selectorFor(el),
      attrs,
      text: textOf(el),
      label: el.getAttribute("aria-label") || el.getAttribute("alt") || "",
      context: textOf(el.parentElement, 800),
      box: { width: r.width, height: r.height },
    };
  }
  function selectedTarget(target) {
    let el = target instanceof Element ? target : target?.parentElement;
    if (!el || el === host || el === document.documentElement) return null;
    if (el.closest("svg")) el = el.closest("svg").parentElement;
    return (
      el?.closest(
        'a,button,h1,h2,h3,h4,p,li,figure,img,video,canvas,[role="button"]',
      ) || el
    );
  }
  function viewport() {
    return {
      width: innerWidth,
      height: innerHeight,
      scrollX,
      scrollY,
      devicePixelRatio,
      visualScale: visualViewport?.scale || 1,
    };
  }
  function interactionState(el) {
    return {
      hovered: [...document.querySelectorAll(":hover")]
        .filter(
          (e) =>
            e !== host && e !== document.body && e !== document.documentElement,
        )
        .slice(-5)
        .map((e) => ({ tag: e.localName, label: textOf(e, 120) })),
      expanded: el?.getAttribute("aria-expanded"),
      selected: el?.getAttribute("aria-selected"),
      detailsOpen: Boolean(el?.closest("details")?.open),
    };
  }
  function resolveNote(note, currentSignature) {
    const pageSimilarity = Core.similarity(
      note.pageSignature,
      currentSignature,
    );
    if (note.pageSignature?.length > 40 && pageSimilarity < 0.46)
      return { status: "changed" };
    if (note.type === "page")
      return { status: "found", element: document.body };
    if (!note.anchor?.tag || !/^[a-z][a-z0-9-]*$/i.test(note.anchor.tag))
      return { status: "missing" };
    const elements = new Set();
    try {
      for (const el of document.querySelectorAll(note.anchor.selector))
        if (el !== host) elements.add(el);
    } catch {}
    const candidates = document.querySelectorAll(note.anchor.tag);
    for (const el of candidates) {
      if (elements.size >= 500) break;
      if (el !== host && el.getClientRects().length) elements.add(el);
    }
    const list = [...elements];
    const result = Core.rankAnchors(note.anchor, list.map(descriptor));
    if (result.status !== "found") return result;
    const element = list[result.index];
    if (note.type === "region") {
      const r = element.getBoundingClientRect(),
        old = note.anchor.box;
      if (
        !old?.width ||
        !old.height ||
        pageSimilarity < 0.9 ||
        Math.abs(r.width / old.width - 1) > 0.12 ||
        Math.abs(r.height / old.height - 1) > 0.12
      )
        return { status: "uncertain" };
    }
    return { ...result, element };
  }
  let notesRequest = 0;
  async function loadNotes() {
    const request = ++notesRequest;
    const at = location.href;
    const notes = await send("LIST");
    if (!state.enabled || at !== location.href || request !== notesRequest) return;
    state.notes = notes.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const currentSignature = signature();
    state.matches = new Map(
      state.notes.map((note) => [note.id, resolveNote(note, currentSignature)]),
    );
    renderWidget();
    renderMarkers();
    if (state.panel === "menu" || state.panel === "notes") renderPanel();
    send("LOCATION_RESULTS", {
      results: state.notes.map((note) => ({
        id: note.id,
        status: state.matches.get(note.id).status,
      })),
    }).catch(() => {});
  }
  function mount() {
    if (host?.isConnected) return;
    privatePanel?.destroy();
    document.querySelector("#page-review-overlay[data-page-review]")?.remove();
    host = document.createElement("div");
    host.id = "page-review-overlay";
    host.setAttribute("data-page-review", "");
    shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = PageReviewStyles;
    shadow.append(style);
    for (const id of [
      "widget",
      "markers",
      "selection",
      "panel",
      "notifications",
    ]) {
      const el = document.createElement("div");
      el.id = id;
      shadow.append(el);
    }
    document.documentElement.append(host);
    controller = new AbortController();
    const options = { signal: controller.signal };
    privatePanel = PageReviewPrivatePanel({
      container: shadow.getElementById("panel"),
      send,
      onError: (error) => toast(error.message),
      onEvent: (event) => {
        if (typeof event.comment === "string") {
          if (state.panel === "editor" && state.draft)
            state.draft.note.comment = event.comment;
          if (state.panel === "record" && state.record)
            state.record.seed.note.comment = event.comment;
        }
        if (event.kind === "action") void action(event.dataset);
        if (event.kind === "key") keyDown({ ...event, preventDefault() {} });
      },
    });
    shadow.addEventListener("click", (event) => {
      const button = event.target.closest("[data-action]");
      if (!event.isTrusted || !button) return;
      event.preventDefault();
      event.stopPropagation();
      void action(button.dataset);
    }, options);
    shadow.addEventListener("pointerdown", orbDown, options);
    document.addEventListener("click", selectClick, {
      ...options,
      capture: true,
    });
    document.addEventListener("pointermove", pointerMove, {
      ...options,
      capture: true,
    });
    document.addEventListener("pointerdown", pointerDown, {
      ...options,
      capture: true,
    });
    document.addEventListener("pointerup", pointerUp, {
      ...options,
      capture: true,
    });
    document.addEventListener("pointercancel", cancelPointer, options);
    document.addEventListener("keydown", (event) => {
      if (event.isTrusted) keyDown(event);
    }, { ...options, capture: true });
    window.addEventListener(
      "resize",
      () => {
        if (state.record?.phase === "recording")
          stopRecording("视口已改变，保留已录部分").catch((e) =>
            toast(e.message),
          );
        schedulePosition();
      },
      options,
    );
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.hidden && state.record?.phase === "recording")
          stopRecording("已切换页面，保留已录部分").catch(() => {});
      },
      options,
    );
    window.addEventListener("scroll", schedulePosition, {
      ...options,
      capture: true,
      passive: true,
    });
    window.addEventListener("popstate", pageChanged, options);
    window.addEventListener("hashchange", pageChanged, options);
    if (globalThis.navigation)
      navigation.addEventListener("navigatesuccess", pageChanged, options);
    observer = new MutationObserver(() => {
      if (observerTimer || state.busy || state.draft || state.record) return;
      observerTimer = setTimeout(() => {
        observerTimer = null;
        pageChanged();
        loadNotes().catch((error) => toast(error.message));
      }, 250);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    privatePanel.prepare();
    renderWidget();
    renderPanel();
  }
  function unmount() {
    operation++;
    controller?.abort();
    observer?.disconnect();
    clearTimeout(observerTimer);
    observerTimer = null;
    cancelAnimationFrame(frame);
    clearTimeout(toastTimer);
    privatePanel?.destroy();
    privatePanel = null;
    host?.remove();
    host = null;
    shadow = null;
    if (state.previousDraft) {
      state.draft = state.previousDraft;
      state.previousDraft = null;
    }
    state.record = null;
    state.recordSeed = null;
    setMode("browse");
    state.panel = null;
    state.hover = null;
    state.rebind = null;
    drag = null;
    regionDrag = null;
    state.busy = false;
  }
  async function refresh() {
    try {
      const setting = await send("GET_SETTINGS");
      state.enabled = setting.enabled;
      state.dock = setting.dock;
      if (state.enabled) {
        mount();
        await loadNotes();
        const id = await send("TAKE_FOCUS");
        if (id) locate(id);
      } else unmount();
    } catch (error) {
      if (host) toast(error.message);
    }
  }
  function pageChanged() {
    if (route === location.href) return;
    route = location.href;
    if (regionDrag) {
      regionDrag = null;
      highlight(null);
    }
    if (state.record) {
      cancelRecording().catch(() => {});
      toast("页面已切换，本次录制已停止");
    }
    if (state.draft) {
      state.draft.error =
        "网页已经切换，原评注尚未保存。请返回原页面后保存，或复制评注内容。";
      renderPanel();
    } else {
      state.panel = null;
      setMode("browse");
      renderPanel();
    }
    loadNotes().catch((error) => toast(error.message));
  }
  function currentAnchor() {
    if (state.panel === "editor" && state.draft) {
      const d = state.draft;
      if (d.note.type === "page") return null;
      if (d.target?.isConnected) {
        const r = d.target.getBoundingClientRect(),
          area = d.note.region;
        return d.note.type === "region" && area
          ? {
              left: r.left + r.width * area.x,
              top: r.top + r.height * area.y,
              width: r.width * area.w,
              height: r.height * area.h,
            }
          : r;
      }
      return d.rect;
    }
    if (state.panel === "peek" && state.peek) {
      const note = state.notes.find((note) => note.id === state.peek.id),
        match = state.matches.get(state.peek.id);
      return note && match?.status === "found" && note.type !== "page"
        ? markRect(note, match)
        : null;
    }
    return null;
  }
  function schedulePosition() {
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = null;
        positionWidget();
        renderMarkers();
        const rect = currentAnchor();
        if (rect) highlight(rect, state.draft?.note.type === "region" ? 0 : 5);
        else if (state.hover) highlight(state.hover.getBoundingClientRect());
      });
  }
  function dockPosition() {
    const y = Math.max(12, innerHeight - Math.max(16, state.dock.bottom) - 44);
    return {
      x: state.dock.side === "left" ? 16 : Math.max(12, innerWidth - 60),
      y,
    };
  }
  function panelContext(dock = dockPosition()) {
    const anchor = currentAnchor();
    return {
      dock: { ...dock, side: state.dock.side },
      anchor: anchor && {
        left: anchor.left, top: anchor.top, width: anchor.width, height: anchor.height,
      },
      recording: state.record && {
        rect: state.record.rect,
        viewport: state.record.viewport,
        activeControls: state.record.activeControls,
      },
    };
  }
  function positionWidget(raw) {
    if (!shadow) return;
    const wrap = shadow.querySelector(".orb-wrap"),
      p = raw || dockPosition();
    if (wrap)
      Object.assign(wrap.style, {
        left: Math.max(12, Math.min(innerWidth - 56, p.x)) + "px",
        top: Math.max(12, Math.min(innerHeight - 56, p.y)) + "px",
      });
    privatePanel?.position(panelContext(p));
  }
  function renderWidget() {
    if (!shadow) return;
    if (
      state.record &&
      ["starting", "waiting", "recording", "stopping"].includes(
        state.record.phase,
      )
    ) {
      shadow.getElementById("widget").replaceChildren();
      renderHint();
      return;
    }
    const active = state.mode !== "browse";
    shadow.getElementById("widget").innerHTML =
      `<div class="orb-wrap"><button class="orb floating-orb ${active ? "is-marking" : ""} ${state.dock.side === "left" ? "docked-left" : ""}" data-action="toggle" aria-label="打开网页评注" aria-expanded="${state.panel === "menu"}" data-hint="${active ? "正在标注 · 点击切换方式" : "网页评注 · 拖动可换位置"}">${icon(active ? "select" : "pen")}${state.notes.length ? `<span class="orb-count">${state.notes.length}</span>` : ""}</button><button class="orb-close" data-action="disable" aria-label="关闭网页评注" title="关闭，点击 Chrome 插件图标重新启用">${icon("close")}</button></div>`;
    positionWidget();
    renderHint();
  }
  function renderHint() {
    if (!shadow) return;
    shadow.querySelector(".hint")?.remove();
    if (state.mode !== "browse") {
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = state.rebind
        ? "选择旧评注的新位置 · Esc 取消"
        : state.mode === "record-area"
          ? "框选录制区域 · Esc 取消"
          : state.mode === "area"
            ? "拖动圈出关注区域 · Esc 退出"
            : "点选关注的地方 · Esc 退出";
      shadow.getElementById("selection").append(hint);
    }
  }
  function markRect(note, match) {
    if (note.type === "page") return { left: 18, top: 16, width: 0, height: 0 };
    const r = match.element?.getBoundingClientRect();
    if (!r) return null;
    if (note.type === "region" && note.region)
      return {
        left: r.left + r.width * note.region.x,
        top: r.top + r.height * note.region.y,
        width: r.width * note.region.w,
        height: r.height * note.region.h,
      };
    return r;
  }
  function renderMarkers() {
    if (!shadow) return;
    const markerRoot = shadow.getElementById("markers");
    markerRoot.innerHTML = "";
    if (state.record || !state.showMarkers || state.mode !== "browse") return;
    const positions = new Map();
    state.notes.forEach((note, index) => {
      const match = state.matches.get(note.id);
      if (match?.status !== "found") return;
      const r = markRect(note, match);
      if (
        !r ||
        r.top > innerHeight ||
        r.top + r.height < 0 ||
        r.left > innerWidth ||
        r.left + r.width < 0
      )
        return;
      const base = `${Math.round(r.left)},${Math.round(r.top)}`,
        count = positions.get(base) || 0;
      positions.set(base, count + 1);
      const button = document.createElement("button");
      button.className = "pin note-pin";
      button.dataset.action = "peek";
      button.dataset.id = note.id;
      button.textContent = String(index + 1).padStart(2, "0");
      button.setAttribute("aria-label", `查看评注 ${index + 1}`);
      Object.assign(button.style, {
        left:
          Math.max(4, Math.min(innerWidth - 29, r.left - 12 + count * 26)) +
          "px",
        top: Math.max(4, r.top - 12) + "px",
      });
      markerRoot.append(button);
      if (note.type === "region") {
        const box = document.createElement("div");
        box.className = "region region-saved";
        Object.assign(box.style, {
          left: r.left + "px",
          top: r.top + "px",
          width: r.width + "px",
          height: r.height + "px",
        });
        markerRoot.append(box);
      }
    });
  }
  function panelHead(title, subtitle = "") {
    return `<header class="orb-menu-head"><div><strong>${esc(title)}</strong>${subtitle ? `<span>${esc(subtitle)}</span>` : ""}</div><button class="icon-btn" data-action="minimize" aria-label="收起到右下角" title="收起到右下角">${icon("close")}</button></header>`;
  }
  function statusMarkup(status) {
    return `<span class="status-label ${status === "found" ? "" : status === "uncertain" ? "warning" : "stale"}">${icon(status === "found" ? "pin" : "note")}${labels[status] || "位置待确认"}</span>`;
  }
  function feedbackMarkup(note) {
    return note.feedback
      ? `<span class="feedback-value ${esc(note.feedback)}" role="img" aria-label="${note.feedback === "positive" ? "点赞" : "点踩"}">${icon(note.feedback === "positive" ? "like" : "dislike")}</span>`
      : "";
  }
  function composerState() {
    const d = state.draft;
    return d && {
      canSave: !state.busy && Boolean(d.note.id || d.asset || d.allowWithoutImage),
      feedback: d.note.feedback,
    };
  }
  const clock = (s) =>
    Math.floor((s || 0) / 60) +
    ":" +
    String(Math.floor((s || 0) % 60)).padStart(2, "0");
  const date = (value) =>
    new Date(value).toLocaleString("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  function draftMedia(d) {
    const asset = d.asset;
    if (!asset)
      return `<div class="media-empty">${state.busy ? "正在截图…" : d.allowWithoutImage ? "仅评注" : d.error ? esc(d.error) : "截图尚未完成"}${!state.busy ? '<button class="text-button" data-action="retry">' + (d.error ? "重试" : "添加截图") + "</button>" : ""}${!d.allowWithoutImage && !state.busy ? '<button class="text-button" data-action="allow-text">仅保存评注</button>' : ""}</div>`;
    return `<div class="draft-media">${asset.video ? `<video src="${esc(asset.video)}" poster="${esc(asset.viewport)}" controls muted playsinline></video><div class="media-duration">${clock(asset.recording.duration)}</div>` : `<button class="image-preview" data-action="expand-media" aria-label="放大截图"><img src="${esc(asset.crop || asset.viewport)}" alt="截图"></button>`}${asset.frames?.length ? `<div class="keyframes">${asset.frames.map((f) => `<button data-action="seek-frame" data-at="${Number(f.at)}" aria-label="跳转 ${clock(f.at)}"><img src="${esc(f.data)}" alt=""><time>${clock(f.at)}</time></button>`).join("")}</div>` : ""}<div class="media-tools">${asset.video ? '<button data-action="retake-record">重录</button><button data-action="reselect-video">重选区域</button>' : '<button data-action="retry">重拍</button>'}<button data-action="remove-media">移除</button></div></div>`;
  }
  function connectionMarkup() {
    const c = state.cloud || {},
      ready = c.cliConnections?.length,
      cap = c.capabilities;
    return `<section class="panel setup-panel" role="dialog" aria-label="连接设置">${panelHead("连接设置")}<div class="setup-body">${!c.configured ? '<button class="btn primary full" data-action="login">登录账号</button>' : `<div class="setup-account">${esc(c.name || "已登录")}<span class="connected-dot">●</span></div>${ready ? `<div class="setup-connected"><strong>终端已连接</strong>${c.cliConnections.map((n) => `<span>${esc(n.device_name)}</span>`).join("")}</div>` : `${cap?.cliAvailable && cap?.terminalConnect === 1 ? '<button class="btn primary full" data-action="copy-install">复制 macOS 安装命令</button><button class="btn full" data-action="copy-login">连接终端 · 复制命令</button>' : `<p class="muted">${cap ? "终端连接组件需要更新" : "服务需要更新，暂不能连接终端"}</p>`}`}<button class="text-button" data-action="check-connection">检查连接</button>`}<button class="text-button" data-action="library">管理账号与连接 ${icon("arrow")}</button></div></section>`;
  }
  function copyMarkup() {
    const issue = state.copyIssue;
    return `<div class="copy-region"><button class="btn primary copy-main" data-action="copy" ${state.copying ? "disabled" : ""}>${icon("copy")}${state.copying ? "正在准备…" : "复制本页评注"}</button><button class="text-button" data-action="copy-full" ${state.copying ? "disabled" : ""}>复制完整指令</button>${issue ? `<p class="inline-error" role="alert">${esc(issue.message)}<button class="text-button" data-action="${issue.action}" ${state.copying ? "disabled" : ""}>${issue.label}</button></p>` : ""}</div>`;
  }
  function renderPanel(focus = false) {
    if (!shadow) return;
    let html = "";
    const d = state.draft;
    if (state.panel === "menu")
      html = `<section class="panel orb-menu" role="dialog" aria-label="网页评注操作"><header class="orb-menu-head"><strong>网页评注</strong><div class="head-actions"><button class="icon-btn" data-action="settings" aria-label="连接设置">${icon("settings")}</button><button class="icon-btn" data-action="minimize" aria-label="收起悬浮窗">${icon("close")}</button></div></header><div class="v4-pick">${[
        ["point", "select", "点选"],
        ["area", "area", "框选"],
        ["page", "note", "整页"],
        ["record", "record", "录制"],
      ]
        .map(
          ([action, i, text]) =>
            `<button data-action="${action}">${icon(i)}${text}</button>`,
        )
        .join(
          "",
        )}</div><button class="page-link" data-action="notes"><span>${icon("note")}本页评注</span><span>${state.notes.length}${icon("arrow")}</span></button>${copyMarkup()}<footer class="menu-footer"><button data-action="library">${icon("history")}历史记录</button><button class="icon-btn" data-action="markers" aria-label="${state.showMarkers ? "隐藏" : "显示"}页面标记" aria-pressed="${state.showMarkers}">${icon("eye")}</button></footer></section>`;
    else if (state.panel === "settings") html = connectionMarkup();
    else if (state.panel === "editor" && d)
      html = `<section class="panel editor popover v4-composer" role="dialog" aria-label="${d.note.id ? "修改评注" : "添加评注"}" aria-busy="${state.busy}"><header class="popover-head"><span>${esc(d.note.label || "评注")}</span><button class="icon-btn" data-action="cancel-draft" aria-label="取消评注">${icon("close")}</button></header>${d.note.id ? "" : draftMedia(d)}<textarea id="review-comment" aria-label="评注内容" placeholder="添加评注…" maxlength="12000">${esc(d.note.comment)}</textarea>${d.error && (d.asset || d.note.id) ? `<p class="inline-error" role="alert">${esc(d.error)}</p>` : ""}<footer class="composer-bottom"><div class="feedback-actions">${["positive", "negative"].map((v) => `<button class="feedback-button" data-action="feedback" data-feedback="${v}" aria-label="${v === "positive" ? "点赞" : "点踩"}" aria-pressed="${d.note.feedback === v}">${icon(v === "positive" ? "like" : "dislike")}</button>`).join("")}</div><button class="btn primary composer-submit" data-action="save">保存</button></footer></section>`;
    else if (state.panel === "notes")
      html = `<div class="drawer-backdrop" data-action="minimize"></div><aside class="panel drawer notes-panel" role="dialog" aria-modal="true" aria-label="本页评注"><header class="drawer-head"><h2>本页评注</h2><button class="icon-btn" data-action="minimize" aria-label="关闭本页评注">${icon("close")}</button></header><div class="drawer-content">${state.pageError ? `<p class="inline-error" role="alert">${esc(state.pageError)}</p>` : ""}${state.notes.length ? state.notes.map((n, i) => `<article class="drawer-note"><div class="saved-head"><span>${feedbackMarkup(n)}${esc(n.label)}</span><time>${date(n.createdAt)}</time></div><p>${esc(n.comment)}</p><div class="drawer-note-actions"><button data-action="peek" data-id="${esc(n.id)}">${n.hasVideo ? "播放录制" : n.hasImage ? "查看截图" : "查看评注"}</button><button data-action="edit" data-id="${esc(n.id)}">修改</button><button data-action="locate" data-id="${esc(n.id)}">定位</button><button data-action="delete" data-id="${esc(n.id)}">删除</button></div></article>`).join("") : '<div class="empty-state">本页还没有评注</div>'}</div><footer class="drawer-footer"><span>${state.notes.length} 条</span>${copyMarkup()}</footer></aside>`;
    else if (state.panel === "peek" && state.peek) {
      const n = state.notes.find((n) => n.id === state.peek.id),
        a = state.peek.asset;
      if (n)
        html = `<div class="drawer-backdrop" data-action="close-peek"></div><aside class="panel drawer notes-panel" role="dialog" aria-modal="true" aria-label="评注详情"><header class="drawer-head"><h2>评注详情</h2><button class="icon-btn" data-action="close-peek" aria-label="关闭详情">${icon("close")}</button></header><div class="drawer-content"><div class="saved-head"><a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">${esc(new URL(n.url).hostname)}</a><time>${date(n.createdAt)}</time></div>${feedbackMarkup(n)}<p class="detail-comment">${esc(n.comment)}</p>${state.peek.error ? `<p class="inline-error" role="alert">${esc(state.peek.error)}</p>` : ""}<div class="drawer-note-actions"><button data-action="edit" data-id="${esc(n.id)}">修改</button><button data-action="delete" data-id="${esc(n.id)}">删除</button></div>${a?.video ? `<video class="saved-video" src="${esc(a.video)}" poster="${esc(a.viewport)}" controls muted playsinline></video>${a.frames?.length ? `<div class="keyframes">${a.frames.map((f) => `<button data-action="seek-frame" data-at="${Number(f.at)}" aria-label="跳转 ${clock(f.at)}"><img src="${esc(f.data)}" alt=""><time>${clock(f.at)}</time></button>`).join("")}</div>` : ""}` : a?.viewport ? `<button class="image-preview" data-action="expand-media" aria-label="放大截图"><img src="${esc(a.viewport)}" alt="截图"></button>` : ""}</div></aside>`;
    } else if (state.panel === "media") {
      const a = state.draft?.asset || state.peek?.asset;
      html = `<div class="drawer-backdrop" data-action="close-media"></div><section class="panel media-view" role="dialog" aria-modal="true" aria-label="截图">${panelHead("截图")}<button class="icon-btn media-close" data-action="close-media" aria-label="关闭截图">${icon("close")}</button><img src="${esc(a?.viewport || "")}" alt="截图"></section>`;
    } else if (state.panel === "record" && state.record) {
      const r = state.record;
      const preparing = ["ready", "failed"].includes(r.phase);
      html = `<section class="panel recording-control${preparing ? "" : " recording-control-active"}" role="dialog" aria-label="区域录制"><span>${r.phase === "recording" ? '<i class="record-dot"></i> 录制中' : r.phase === "waiting" ? "点击工具栏图标以允许录制" : r.phase === "starting" ? "正在启动…" : r.phase === "stopping" ? "正在处理…" : "区域录制"}</span>${r.phase === "recording" ? '<button class="btn primary small" data-action="stop-record">停止</button>' : ["ready", "failed"].includes(r.phase) ? '<button class="btn small" data-action="reselect-record">重选</button><button class="btn primary small" data-action="start-record">' + (r.phase === "failed" ? "重试" : "开始") + "</button>" : ""}<button class="icon-btn" data-action="cancel-record" aria-label="取消录制">${icon("close")}</button>${preparing ? `<textarea id="review-comment" aria-label="评注内容" placeholder="添加评注…" maxlength="12000">${esc(r.seed.note.comment)}</textarea>` : ""}${r.error ? `<p class="inline-error" role="alert">${esc(r.error)}</p>` : ""}</section>`;
    } else if (state.panel === "confirm") {
      const deleting = state.confirm?.kind === "delete";
      html = `<section class="panel confirm-panel" role="dialog" aria-modal="true" aria-label="${deleting ? "删除评注" : "放弃评注"}"><div class="confirm-body"><h3>${deleting ? "删除这条评注？" : "放弃未保存的评注？"}</h3><div class="confirm-row"><button class="btn" data-action="${deleting ? "close-peek" : "confirm-cancel"}">保留</button><button class="btn danger" data-action="${deleting ? "confirm-delete" : "confirm-discard"}">${deleting ? "删除" : "放弃"}</button></div></div></section>`;
    } else if (state.panel === "copy-fallback")
      html = `<section class="panel setup-panel" role="dialog" aria-label="手动复制">${panelHead("手动复制")}<div class="setup-body"><textarea id="manual-copy" readonly aria-label="评注提示词">${esc(state.copyText)}</textarea></div></section>`;
    else if (state.panel === "confirm-close")
      html = `<section class="panel confirm-panel" role="dialog" aria-label="未保存评注"><div class="confirm-body"><h3>这条评注尚未保存</h3><button class="btn" data-action="resume-draft">继续编辑</button><button class="btn danger" data-action="discard-disable">放弃并关闭</button></div></section>`;
    privatePanel.render(html, panelContext(), { focus, composer: composerState() });
    if (state.record) {
      shadow.querySelector(".record-boundary")?.remove();
      const r = state.record.rect,
        b = document.createElement("div");
      b.className = "record-boundary";
      Object.assign(b.style, {
        left: r.left + "px",
        top: r.top + "px",
        width: r.width + "px",
        height: r.height + "px",
      });
      shadow.getElementById("selection").append(b);
    } else shadow.querySelector(".record-boundary")?.remove();
    const rect = currentAnchor();
    if (rect) highlight(rect, d?.note.type === "region" ? 0 : 5);
    else if (state.mode === "browse") highlight(null);

  }

  function toast(message) {
    if (!shadow) return;
    clearTimeout(toastTimer);
    shadow.getElementById("notifications").innerHTML =
      `<div class="toast" role="status">${esc(message)}</div>`;
    toastTimer = setTimeout(() => {
      shadow?.getElementById("notifications").replaceChildren();
    }, 4500);
  }
  function highlight(rect, offset = 5) {
    if (!shadow) return;
    shadow.querySelector(".highlight")?.remove();
    if (!rect) return;
    const box = document.createElement("div");
    box.className = "highlight";
    Object.assign(box.style, {
      left: rect.left - offset + "px",
      top: rect.top - offset + "px",
      width: rect.width + offset * 2 + "px",
      height: rect.height + offset * 2 + "px",
    });
    shadow.getElementById("selection").append(box);
  }
  function collapse() {
    if (state.draft) {
      state.panel = "editor";
      renderPanel(true);
      return;
    }
    state.panel = null;
    setMode("browse");
    state.hover = null;
    state.rebind = null;
    highlight(null);
    renderWidget();
    renderPanel();
    renderMarkers();
  }
  function setMode(mode) {
    state.mode = mode;
    if (mode !== "record-area") state.recordSeed = null;
    const selecting = mode === "area" || mode === "record-area";
    if (selecting && !regionCursorSheet) {
      regionCursorSheet = new CSSStyleSheet();
      // Keep page hit testing intact so region anchors still resolve underneath.
      regionCursorSheet.replaceSync(':root, :root *:not(#page-review-overlay) { cursor: crosshair !important; }');
      document.adoptedStyleSheets.push(regionCursorSheet);
    } else if (!selecting && regionCursorSheet) {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
        (sheet) => sheet !== regionCursorSheet,
      );
      regionCursorSheet = null;
    }
  }
  function enter(mode) {
    if (state.draft) {
      state.panel = "editor";
      renderPanel(true);
      toast("先保存或取消当前评注");
      return;
    }
    setMode(mode);
    state.panel = null;
    state.hover = null;
    renderWidget();
    renderPanel();
    renderMarkers();
  }
  async function snapshot(draft) {
    const run = ++operation;
    state.busy = true;
    draft.error = "";
    const target = draft.target;
    try {
      if (location.href !== draft.note.url)
        throw new Error("网页已切换，未截取新页面");
      const rect = draft.note.type === "page" ? null : draft.rect;
      if (target && !target.isConnected)
        throw new Error("目标已移除，请重新选取或仅保存文字");
      host.style.setProperty("visibility", "hidden", "important");
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      const asset = await send("CAPTURE", {
        url: draft.note.url,
        viewport: draft.note.viewport,
        rect,
        noteType: draft.note.type,
      });
      if (run !== operation) return;
      draft.asset = asset;
      draft.note.capturedAt = asset.capturedAt;
      draft.note.screenshotError = "";
    } catch (error) {
      if (run === operation) {
        const reason = String(error.message || "");
        draft.error = /activeTab|<all_urls>/i.test(reason)
          ? "请点击浏览器工具栏中的网页评注，再重试截图"
          : /[\u4e00-\u9fff]/.test(reason)
            ? reason
            : "截图失败，请重试或仅保存评注";
        draft.note.screenshotError = draft.error;
      }
    } finally {
      host?.style.removeProperty("visibility");
      if (run === operation) {
        state.busy = false;
        state.panel = "editor";
        renderPanel(true);
        renderWidget();
      }
    }
  }
  async function begin(type, target, rect, region = null) {
    if (state.busy || state.draft) return;
    setMode("browse");
    state.hover = null;
    highlight(null);
    state.panel = null;
    renderPanel();
    renderMarkers();
    const anchor = target ? descriptor(target) : null;
    const label =
      type === "page"
        ? "整页观察"
        : type === "region"
          ? "选定区域"
          : (anchor.label || anchor.text || target.localName).slice(0, 50);
    const draft = {
      target,
      rect: rect
        ? {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          }
        : null,
      note: {
        url: location.href,
        title: document.title,
        type,
        label,
        anchor,
        region,
        comment: "",
        kind: "observation",
        pageSignature: signature(),
        viewport: viewport(),
        state: interactionState(target),
      },
    };
    state.draft = draft;
    await snapshot(draft);
  }
  async function save(keepSelecting) {
    const draft = state.draft;
    if (!draft || state.busy) return;
    state.busy = true;
    renderPanel();
    try {
      await send("SAVE", {
        note: draft.note,
        asset: draft.recordingId ? undefined : draft.asset,
        recordingId: draft.recordingId,
        revision: draft.note.revision,
        allowWithoutImage: draft.allowWithoutImage,
      });
      state.draft = null;
      state.panel = null;
      setMode(keepSelecting ? "point" : "browse");
      operation++;
      await loadNotes();
      renderPanel();
      renderWidget();
      renderMarkers();
      toast(keepSelecting ? "已保存" : "已保存");
    } catch (error) {
      draft.error = error.message;
    } finally {
      state.busy = false;
      if (state.draft) renderPanel(true);
    }
  }
  async function peek(id) {
    if (state.draft) {
      toast("先保存或取消当前评注");
      return;
    }
    const note = state.notes.find((n) => n.id === id);
    if (!note) return;
    const view = { id, asset: null };
    state.peek = view;
    state.panel = "peek";
    renderPanel();
    try {
      view.asset = await send("GET_ASSET", { id });
    } catch (error) {
      view.error = error.message;
    }
    if (state.peek === view && state.panel === "peek" && (view.asset || view.error))
      renderPanel();
  }
  function locate(id) {
    const match = state.matches.get(id),
      note = state.notes.find((n) => n.id === id);
    if (!note) return;
    if (match?.status !== "found") {
      state.panel = "notes";
      renderPanel();
      toast("原位置需要确认，可查看原画面");
      return;
    }
    const r = markRect(note, match);
    if (note.type === "region" && r)
      window.scrollBy({
        top: r.top - innerHeight / 3,
        left: r.left < 0 ? r.left : 0,
        behavior: "instant",
      });
    else if (note.type !== "page")
      match.element.scrollIntoView({ block: "center", behavior: "instant" });
    peek(id).catch((error) => toast(error.message));
  }
  async function action(dataset) {
    const name = dataset.action;
    if (name === "toggle" && performance.now() < suppressClick) return;
    if (state.busy) return;
    try {
      switch (name) {
        case "toggle":
          state.panel = state.panel ? null : state.draft ? "editor" : state.record ? "record" : "menu";
          renderPanel(Boolean(state.draft));
          renderWidget();
          if (state.panel === "menu")
            refreshPageState().catch((e) => toast(e.message));
          break;
        case "minimize":
          collapse();
          break;
        case "disable":
          if (
            state.draft &&
            (state.draft.note.comment.trim() || state.draft.note.feedback)
          ) {
            state.panel = "confirm-close";
            renderPanel();
          } else await send("DISABLE");
          break;
        case "discard-disable":
          state.draft = null;
          await send("DISABLE");
          break;
        case "resume-draft":
          state.panel = "editor";
          renderPanel(true);
          break;
        case "point":
          enter("point");
          break;
        case "area":
          enter("area");
          break;
        case "record":
          if (state.draft) {
            toast("请先保存当前评注");
            break;
          }
          state.recordSeed = null;
          enter("record-area");
          break;
        case "settings":
          state.cloud = await send("CLOUD_SETUP");
          state.panel = "settings";
          renderPanel();
          break;
        case "login":
          await send("CLOUD_LOGIN", state.copyResumePanel ? { resume: "copy" } : {});
          if (state.copyResumePanel) {
            await resumeCopy();
            break;
          }
          state.cloud = await send("CLOUD_SETUP");
          state.panel = "settings";
          renderPanel();
          break;
        case "check-connection":
          state.cloud = await send("CLOUD_SETUP");
          if (state.cloud.cliConnections?.length && state.copyResumePanel) {
            await resumeCopy();
            break;
          }
          renderPanel();
          toast(
            state.cloud.cliConnections?.length
              ? "终端已连接"
              : "尚未收到终端连接",
          );
          break;
        case "login-copy":
          await copyPage({ login: true, format: state.copyFormat });
          break;
        case "copy-install":
          await clipboard(
            "curl -fsSL " + state.cloud.capabilities.installUrl + " | sh",
          );
          toast("已复制安装命令");
          break;
        case "copy-login":
          await clipboard("page-review connect --api " + state.cloud.apiUrl + " --workspace " + state.cloud.workspaceId);
          toast("已复制登录命令");
          break;
        case "copy-retry":
          await copyPage({ format: state.copyFormat });
          break;
        case "copy-full":
          await copyPage({ format: "full" });
          break;
        case "copy":
          await copyPage();
          break;
        case "start-record":
          await startRecording();
          break;
        case "stop-record":
          await stopRecording();
          break;
        case "cancel-record":
          await cancelRecording();
          break;
        case "reselect-record": {
          const record = state.record;
          state.recordSeed = record?.seed;
          state.record = null;
          state.panel = null;
          setMode("record-area");
          renderPanel();
          renderWidget();
          break;
        }
        case "retake-record":
          await retakeRecording(false);
          break;
        case "reselect-video":
          await retakeRecording(true);
          break;
        case "remove-media":
          if (state.draft) {
            if (state.draft.recordingId)
              await send("DELETE_RECORD_DRAFT", {
                id: state.draft.recordingId,
              });
            state.draft.asset = null;
            state.draft.recordingId = null;
            state.draft.allowWithoutImage = true;
            state.draft.error = "";
            renderPanel();
          }
          break;
        case "expand-media":
          state.mediaBack = state.panel;
          state.panel = "media";
          renderPanel();
          break;
        case "close-media":
          state.panel = state.mediaBack || "editor";
          renderPanel();
          break;
        case "allow-text":
          if (state.draft) {
            state.draft.allowWithoutImage = true;
            state.draft.error = "";
            renderPanel(true);
          }
          break;
        case "close-peek":
          state.peek = null;
          state.panel = "notes";
          renderPanel();
          break;
        case "confirm-cancel":
          state.confirm = null;
          state.panel = "editor";
          renderPanel(true);
          break;
        case "confirm-discard":
          await discardDraft();
          break;
        case "delete":
          state.confirm = { kind: "delete", id: dataset.id };
          state.panel = "confirm";
          renderPanel();
          break;
        case "confirm-delete":
          state.busy = true;
          try {
            await send("DELETE", { id: state.confirm.id });
            state.confirm = state.peek = null;
            state.panel = "notes";
            await loadNotes();
            renderPanel();
            toast("已删除");
          } finally {
            state.busy = false;
          }
          break;
        case "page":
          if (state.draft) {
            state.panel = "editor";
            renderPanel(true);
          } else await begin("page", null, null);
          break;
        case "finish":
          setMode("browse");
          state.hover = null;
          highlight(null);
          renderWidget();
          renderMarkers();
          renderPanel();
          break;
        case "markers":
          state.showMarkers = !state.showMarkers;
          renderMarkers();
          renderPanel();
          break;
        case "notes":
          if (state.draft) {
            toast("先保存或取消当前评注");
            break;
          }
          state.panel = "notes";
          setMode("browse");
          highlight(null);
          renderPanel();
          renderMarkers();
          break;
        case "library":
          await send("OPEN_LIBRARY");
          break;
        case "feedback":
          if (state.draft) {
            state.draft.note.feedback =
              state.draft.note.feedback === dataset.feedback
                ? null
                : dataset.feedback;
            privatePanel.composer(composerState());
          }
          break;
        case "retry":
          if (state.draft?.recordingId) {
            await retakeRecording(false);
            break;
          }
          if (state.draft) {
            const d = state.draft;
            d.note.viewport = viewport();
            if (d.target) {
              const r = d.target.getBoundingClientRect();
              d.rect =
                d.note.type === "region" && d.note.region
                  ? {
                      left: r.left + r.width * d.note.region.x,
                      top: r.top + r.height * d.note.region.y,
                      width: r.width * d.note.region.w,
                      height: r.height * d.note.region.h,
                    }
                  : r;
            }
            d.note.state = interactionState(d.target);
            await snapshot(d);
          }
          break;
        case "save":
          await save(false);
          break;
        case "save-continue":
          await save(true);
          break;
        case "cancel-draft":
          if (
            state.draft &&
            (state.draft.note.comment.trim() ||
              state.draft.note.feedback ||
              state.draft.recordingId)
          ) {
            state.confirm = { kind: "discard" };
            state.panel = "confirm";
            renderPanel();
          } else await discardDraft();
          break;
        case "close-popup":
          state.peek = null;
          state.panel = null;
          renderPanel();
          break;
        case "peek":
          await peek(dataset.id);
          break;
        case "locate":
          locate(dataset.id);
          break;
        case "edit": {
          const note = state.notes.find((n) => n.id === dataset.id);
          if (!note) break;
          const match = state.matches.get(note.id);
          state.draft = {
            note: { ...note },
            target: match?.element || null,
            rect: match?.status === "found" ? markRect(note, match) : null,
          };
          state.panel = "editor";
          renderPanel(true);
          break;
        }
        case "rebind":
          state.rebind = dataset.id;
          enter("point");
          break;
      }
    } catch (error) {
      toast(error.message);
    }
  }
  function orbDown(event) {
    const orb = event.target.closest(".orb");
    if (!event.isTrusted || !orb || event.button !== 0 || state.busy) return;
    const r = orb.getBoundingClientRect();
    drag = {
      x: r.left,
      y: r.top,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      el: orb,
    };
    orb.setPointerCapture(event.pointerId);
  }
  function pointerDown(event) {
    if (
      !event.isTrusted || own(event) ||
      !["area", "record-area"].includes(state.mode) ||
      event.button !== 0 ||
      state.draft ||
      state.busy
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    regionDrag = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    document.documentElement.setPointerCapture?.(event.pointerId);
  }
  function pointerMove(event) {
    if (!event.isTrusted) return;
    if (drag) {
      if (drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - drag.startX,
        dy = event.clientY - drag.startY;
      if (Math.hypot(dx, dy) < 5 && !drag.moved) return;
      drag.moved = true;
      drag.el.classList.add("is-dragging");
      drag.el.setAttribute("aria-expanded", "false");
      if (state.panel) {
        state.panel = null;
        renderPanel();
      }
      positionWidget({ x: drag.x + dx, y: drag.y + dy });
      return;
    }
    if (regionDrag) {
      if (regionDrag.pointerId !== event.pointerId) return;
      highlight(
        {
          left: Math.min(regionDrag.x, event.clientX),
          top: Math.min(regionDrag.y, event.clientY),
          width: Math.abs(event.clientX - regionDrag.x),
          height: Math.abs(event.clientY - regionDrag.y),
        },
        0,
      );
      return;
    }
    if (own(event) || state.mode !== "point" || state.draft || state.busy)
      return;
    const target = selectedTarget(event.target);
    if (target && target !== state.hover) {
      state.hover = target;
      highlight(target.getBoundingClientRect());
    }
  }
  function cancelPointer(event) {
    if (!event.isTrusted || (drag || regionDrag)?.pointerId !== event.pointerId) return;
    drag?.el.classList.remove("is-dragging");
    drag = null;
    regionDrag = null;
    highlight(null);
    positionWidget();
  }
  function pointerUp(event) {
    if (!event.isTrusted) return;
    if (drag) {
      if (drag.pointerId !== event.pointerId) return;
      drag.el.classList.remove("is-dragging");
      if (drag.moved) {
        const r = shadow.querySelector(".orb-wrap").getBoundingClientRect();
        state.dock = {
          side: r.left + 22 < innerWidth / 2 ? "left" : "right",
          bottom: Math.max(16, innerHeight - r.bottom),
        };
        suppressClick = performance.now() + 400;
        send("SAVE_DOCK", { dock: state.dock }).catch((error) =>
          toast(error.message),
        );
      }
      drag = null;
      positionWidget();
      return;
    }
    if (!regionDrag || regionDrag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const start = regionDrag;
    regionDrag = null;
    suppressClick = performance.now() + 300;
    const rect = {
      left: Math.min(start.x, event.clientX),
      top: Math.min(start.y, event.clientY),
      width: Math.abs(event.clientX - start.x),
      height: Math.abs(event.clientY - start.y),
    };
    if (
      rect.width < (state.mode === "record-area" ? 40 : 15) ||
      rect.height < (state.mode === "record-area" ? 40 : 15)
    ) {
      highlight(null);
      if (state.mode === "record-area") toast("选区太小，请重新框选");
      return;
    }
    let target = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    while (target && target !== document.body) {
      const r = target.getBoundingClientRect();
      if (
        r.left <= rect.left &&
        r.top <= rect.top &&
        r.right >= rect.left + rect.width &&
        r.bottom >= rect.top + rect.height
      )
        break;
      target = target.parentElement;
    }
    target = target || document.body;
    const r = target.getBoundingClientRect();
    const region = {
      x: (rect.left - r.left) / r.width,
      y: (rect.top - r.top) / r.height,
      w: rect.width / r.width,
      h: rect.height / r.height,
    };
    if (state.mode === "record-area") {
      prepareRecording(target, rect, region);
      return;
    }
    begin("region", target, rect, region).catch((error) =>
      toast(error.message),
    );
  }
  function selectClick(event) {
    if (!event.isTrusted || own(event)) return;
    if (performance.now() < suppressClick) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (state.mode !== "point" || state.draft || state.busy) return;
    const target = selectedTarget(event.target);
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (state.rebind) {
      const id = state.rebind;
      state.rebind = null;
      setMode("browse");
      highlight(null);
      send("REBIND", {
        id,
        anchor: descriptor(target),
        pageSignature: signature(),
      })
        .then(() => {
          state.panel = "notes";
          return loadNotes();
        })
        .catch((error) => toast(error.message));
      renderWidget();
      return;
    }
    begin("element", target, target.getBoundingClientRect()).catch((error) =>
      toast(error.message),
    );
  }
  function keyDown(event) {
    if (event.key === "Escape") {
      if (state.mode === "record-area" && state.previousDraft) {
        event.preventDefault();
        state.draft = state.previousDraft;
        state.previousDraft = null;
        state.recordSeed = null;
        setMode("browse");
        state.panel = "editor";
        renderPanel(true);
        renderWidget();
        return;
      }
      if (state.record) {
        event.preventDefault();
        cancelRecording().catch((e) => toast(e.message));
        return;
      }
      if (state.draft) {
        event.preventDefault();
        if (state.panel === "media") {
          state.panel = state.mediaBack;
          renderPanel();
        } else {
          state.panel = "editor";
          renderPanel(true);
        }
        return;
      }
      if (state.busy) return;
      setMode("browse");
      state.panel = null;
      state.hover = null;
      state.rebind = null;
      regionDrag = null;
      highlight(null);
      renderPanel();
      renderWidget();
      renderMarkers();
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      event.key === "Enter" &&
      state.panel === "editor"
    ) {
      event.preventDefault();
      save(event.shiftKey && !state.draft?.note.id);
    }
  }
  async function clipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {}
    await send("COPY_TEXT", { text });
  }
  async function refreshPageState() {
    state.pageError = "";
    try {
      await send("REFRESH_PAGE");
    } catch (e) {
      state.pageError = e.message;
    }
    await loadNotes();
  }
  async function resumeCopy() {
    if (state.copyResumePanel) state.panel = state.copyResumePanel;
    state.copyResumePanel = null;
    await copyPage({ format: state.copyFormat });
  }
  async function copyPage({ login = false, format = "reference" } = {}) {
    if (state.copying) return;
    if (state.draft || state.record) {
      toast("请先保存当前评注");
      return;
    }
    state.copying = true;
    state.copyFormat = format;
    state.copyResumePanel = null;
    state.copyIssue = null;
    state.pageError = "";
    renderPanel();
    try {
      if (login) await send("CLOUD_LOGIN", { resume: "copy" });
      const fixed = await send("CREATE_HANDOFF");
      await loadNotes();
      state.copyText = format === "full" ? fixed.text : fixed.reference;
      try {
        await clipboard(state.copyText);
        toast(format === "full" ? "已复制完整指令" : "已复制评注引用，可粘贴到 AI 对话");
      } catch {
        state.panel = "copy-fallback";
      }
    } catch (e) {
      if (e.code === "login_required" || e.code === "cli_not_connected") {
        state.copyResumePanel = state.panel || "menu";
        state.panel = "settings";
        state.cloud = e.code === "login_required" ? { configured: false } :
          await send("CLOUD_SETUP");
        return;
      }
      const actions = {
        account_mismatch: { message: "账号不一致", action: "login-copy", label: "登录原账号" },
        revision_conflict: { message: "评注有更新", action: "library", label: "查看冲突" },
      };
      state.copyIssue = actions[e.code] || (login ? {
        message: "登录未完成", action: "login-copy", label: "重试",
      } : {
        message: "复制失败", action: "copy-retry", label: "重试",
      });
    } finally {
      state.copying = false;
      renderPanel();
    }
  }
  async function discardDraft() {
    operation++;
    if (state.draft?.recordingId)
      await send("DELETE_RECORD_DRAFT", { id: state.draft.recordingId }).catch(
        () => {},
      );
    state.draft = null;
    state.confirm = null;
    state.panel = null;
    setMode("browse");
    renderPanel();
    renderWidget();
  }
  function prepareRecording(target, rect, region) {
    try {
      PageReviewMedia.region(rect, viewport());
      state.record = {
        rect,
        viewport: viewport(),
        phase: "ready",
        target,
        seed: state.recordSeed
          ? {
              note: {
                ...state.recordSeed.note,
                anchor: descriptor(target),
                region,
                viewport: viewport(),
                state: interactionState(target),
              },
            }
          : {
              note: {
                url: location.href,
                title: document.title,
                type: "region",
                label: "区域录制",
                anchor: descriptor(target),
                region,
                comment: "",
                feedback: null,
                pageSignature: signature(),
                viewport: viewport(),
                state: interactionState(target),
              },
            },
      };
      state.recordSeed = null;
      setMode("browse");
      state.panel = "record";
      highlight(null);
      renderPanel();
      renderWidget();
      renderMarkers();
    } catch (e) {
      toast(e.message);
    }
  }
  async function startRecording() {
    const r = state.record;
    if (!r || !["ready", "failed"].includes(r.phase)) return;
    r.viewport = viewport();
    r.seed.note.viewport = r.viewport;
    PageReviewMedia.region(r.rect, r.viewport);
    r.activeControls = PageReviewMedia.activeControls(r.rect, r.viewport);
    if (!r.activeControls) {
      r.error = "请缩小选区，为录制按钮留出空间";
      renderPanel();
      return;
    }
    r.phase = "starting";
    r.error = "";
    state.busy = true;
    renderPanel();
    renderWidget();
    try {
      host.style.setProperty("visibility", "hidden", "important");
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      const result = await send("RECORD_START", {
        url: r.seed.note.url,
        rect: r.rect,
        viewport: r.viewport,
      });
      if (state.record === r)
        r.phase = result.needsToolbar ? "waiting" : "recording";
    } catch (e) {
      if (state.record === r) {
        r.phase = "failed";
        r.error = e.message;
      }
    } finally {
      host?.style.removeProperty("visibility");
      state.busy = false;
      renderPanel();
      renderWidget();
    }
  }
  async function stopRecording(reason) {
    const r = state.record;
    if (!r || r.phase !== "recording") return;
    r.phase = "stopping";
    renderPanel();
    try {
      await send("RECORD_STOP", { reason });
    } catch (e) {
      r.phase = "failed";
      r.error = e.message;
      renderPanel();
    }
  }
  async function cancelRecording() {
    const r = state.record;
    if (!r) return;
    const previous = r.phase;
    r.phase = "cancelling";
    state.record = null;
    state.panel = null;
    setMode("browse");
    if (!["ready", "failed"].includes(previous))
      await send("RECORD_CANCEL").catch(() => {});
    if (state.previousDraft) {
      state.draft = state.previousDraft;
      state.previousDraft = null;
      state.panel = "editor";
    }
    state.recordSeed = null;
    renderPanel(Boolean(state.draft));
    renderWidget();
    renderMarkers();
  }
  async function recordEvent(message) {
    const r = state.record;
    if (!r) {
      if (message.event === "STOPPED")
        await send("DELETE_RECORD_DRAFT", { id: message.draftId }).catch(
          () => {},
        );
      return;
    }
    if (message.event === "STARTED") {
      r.phase = "recording";
      state.busy = false;
      renderPanel();
      renderWidget();
    } else if (message.event === "STOPPED") {
      try {
        const asset = await send("GET_RECORD_DRAFT", { id: message.draftId });
        if (state.previousDraft?.recordingId)
          await send("DELETE_RECORD_DRAFT", {
            id: state.previousDraft.recordingId,
          });
        state.previousDraft = null;
        state.record = null;
        state.draft = {
          ...r.seed,
          target: r.target,
          rect: r.rect,
          recordingId: message.draftId,
          asset,
        };
        state.panel = "editor";
        state.busy = false;
        renderPanel(true);
        renderWidget();
        if (message.reason) toast(message.reason);
      } catch (e) {
        r.phase = "failed";
        r.error = e.message;
        state.busy = false;
        renderPanel();
      }
    } else if (message.event === "ERROR") {
      r.phase = "failed";
      r.error = message.message;
      state.busy = false;
      renderPanel();
      renderWidget();
    }
  }
  async function retakeRecording(reselect) {
    const d = state.draft;
    if (!d?.recordingId) return;
    const rect = d.asset.recording.region,
      vp = d.asset.recording.viewport,
      seed = { note: { ...d.note } };
    state.previousDraft = d;
    state.draft = null;
    if (reselect) {
      state.recordSeed = seed;
      enter("record-area");
    } else {
      state.record = {
        rect,
        viewport: { ...viewport(), ...vp },
        seed,
        target: d.target,
        phase: "ready",
      };
      state.panel = "record";
      renderPanel();
      renderWidget();
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "PAGE_REVIEW_RECORD_EVENT")
      recordEvent(message).catch((e) => toast(e.message));
    if (message?.type === "PAGE_REVIEW_SETTINGS_CHANGED") refresh();
    if (message?.type === "PAGE_REVIEW_LOGIN_RESULT") {
      if (message.ok && message.resume === "copy") {
        state.copying = false;
        resumeCopy().catch((e) => toast(e.message));
      } else if (!message.ok) toast(message.error);
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && "enabled" in changes) refresh();
  });
  window.addEventListener("online", (event) => {
    if (event.isTrusted) send("ONLINE").catch(() => {});
  });
  globalThis.__pageReviewController = { refresh };
  refresh();
})();
