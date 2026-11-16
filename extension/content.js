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
    controller,
    observer,
    observerTimer,
    frame,
    toastTimer,
    drag,
    regionDrag,
    suppressClick = 0,
    operation = 0,
    route = location.href;
  const state = {
    cloud: null,
    copying: false,
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
      throw new Error(result?.error || "插件已更新，请刷新网页后继续");
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
  async function loadNotes() {
    const at = location.href;
    const notes = await send("LIST");
    if (!state.enabled || at !== location.href) return;
    state.notes = notes.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const currentSignature = signature();
    state.matches = new Map(
      state.notes.map((note) => [note.id, resolveNote(note, currentSignature)]),
    );
    renderWidget();
    renderMarkers();
    if (state.panel === "notes") renderPanel();
    send("LOCATION_RESULTS", {
      results: state.notes.map((note) => ({
        id: note.id,
        status: state.matches.get(note.id).status,
      })),
    }).catch(() => {});
  }
  function mount() {
    if (host?.isConnected) return;
    host = document.createElement("div");
    host.id = "page-review-overlay";
    host.setAttribute("data-page-review", "");
    shadow = host.attachShadow({ mode: "open" });
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
    shadow.addEventListener("click", action, options);
    shadow.addEventListener(
      "input",
      (event) => {
        if (event.target.id === "review-comment" && state.draft) {
          state.draft.note.comment = event.target.value;
          updateComposer();
          positionWidget();
        }
      },
      options,
    );
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
    document.addEventListener("keydown", keyDown, {
      ...options,
      capture: true,
    });
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
    host?.remove();
    host = null;
    shadow = null;
    state.mode = "browse";
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
      state.mode = "browse";
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
  function positionWidget(raw) {
    if (!shadow) return;
    const wrap = shadow.querySelector(".orb-wrap"),
      panel = shadow.querySelector(".panel");
    const p = raw || dockPosition();
    if (wrap)
      Object.assign(wrap.style, {
        left: Math.max(12, Math.min(innerWidth - 56, p.x)) + "px",
        top: Math.max(12, Math.min(innerHeight - 56, p.y)) + "px",
      });
    if (panel?.classList.contains("recording-control") && state.record) {
      const pos = PageReviewMedia.controls(
        state.record.rect,
        state.record.viewport,
        {
          width: Math.min(310, innerWidth - 24),
          height: panel.getBoundingClientRect().height,
        },
      );
      if (pos)
        Object.assign(panel.style, {
          left: pos.left + "px",
          top: pos.top + "px",
        });
      return;
    }
    if (panel?.classList.contains("media-view")) {
      const r = panel.getBoundingClientRect();
      Object.assign(panel.style, {
        left: Math.max(12, (innerWidth - r.width) / 2) + "px",
        top: Math.max(12, (innerHeight - r.height) / 2) + "px",
      });
      return;
    }
    if (panel?.classList.contains("drawer")) return;
    if (panel?.classList.contains("popover")) {
      const rect = panel.getBoundingClientRect(),
        anchor = currentAnchor();
      const visible =
        anchor && anchor.top + anchor.height > 0 && anchor.top < innerHeight;
      const position = Core.placePopover(
        visible ? anchor : null,
        { width: innerWidth, height: innerHeight },
        rect,
      );
      Object.assign(panel.style, {
        left: position.left + "px",
        top: position.top + "px",
      });
    } else if (panel) {
      const rect = panel.getBoundingClientRect(),
        gap = 12;
      const left = Math.max(
        12,
        Math.min(
          state.dock.side === "left" ? p.x + 56 : p.x - rect.width - gap,
          innerWidth - rect.width - 12,
        ),
      );
      const top = Math.max(
        12,
        Math.min(p.y + 44 - rect.height, innerHeight - rect.height - 12),
      );
      Object.assign(panel.style, { left: left + "px", top: top + "px" });
    }
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
      button.setAttribute("aria-label", `查看评注 ${index + 1}：${note.label}`);
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
      ? `<span class="feedback-value ${note.feedback}" role="img" aria-label="${note.feedback === "positive" ? "点赞" : "点踩"}">${icon(note.feedback === "positive" ? "like" : "dislike")}</span>`
      : "";
  }
  function updateComposer() {
    const input = shadow?.getElementById("review-comment");
    if (!input || !state.draft) return;
    input.style.height = "auto";
    input.style.height = Math.max(26, Math.min(144, input.scrollHeight)) + "px";
    shadow.querySelectorAll('[data-action="feedback"]').forEach((button) => {
      const selected = state.draft.note.feedback === button.dataset.feedback;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    const save = shadow.querySelector(".composer-submit");
    if (save)
      save.disabled =
        state.busy ||
        !(input.value.trim() || state.draft.note.feedback) ||
        (!state.draft.note.id &&
          !state.draft.asset &&
          !state.draft.allowWithoutImage);
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
    return `<div class="draft-media">${asset.video ? `<video src="${asset.video}" poster="${asset.viewport}" controls muted playsinline></video><div class="media-duration">${clock(asset.recording.duration)}</div>` : `<button class="image-preview" data-action="expand-media" aria-label="放大截图"><img src="${asset.crop || asset.viewport}" alt="截图"></button>`}${asset.frames?.length ? `<div class="keyframes">${asset.frames.map((f, i) => `<button data-action="seek-frame" data-index="${i}" aria-label="跳转 ${clock(f.at)}"><img src="${f.data}" alt=""><time>${clock(f.at)}</time></button>`).join("")}</div>` : ""}<div class="media-tools">${asset.video ? '<button data-action="retake-record">重录</button><button data-action="reselect-video">重选区域</button>' : '<button data-action="retry">重拍</button>'}<button data-action="remove-media">移除</button></div></div>`;
  }
  function connectionMarkup() {
    const c = state.cloud || {},
      ready = c.cliConnections?.length,
      cap = c.capabilities;
    return `<section class="panel setup-panel" role="dialog" aria-label="连接设置">${panelHead("连接设置")}<div class="setup-body">${!c.configured ? '<button class="btn primary full" data-action="login">登录账号</button>' : `<div class="setup-account">${esc(c.name || "已登录")}<span class="connected-dot">●</span></div>${ready ? `<div class="setup-connected"><strong>终端已连接</strong>${c.cliConnections.map((n) => `<span>${esc(n.device_name)}</span>`).join("")}</div>` : `${cap?.cliAvailable ? '<button class="btn primary full" data-action="copy-install">复制 macOS 安装命令</button><button class="btn full" data-action="copy-login">复制终端登录命令</button>' : `<p class="muted">${cap ? "终端安装包尚未发布" : "服务需要更新，暂不能连接终端"}</p>`}`}<button class="text-button" data-action="check-connection">检查连接</button><button class="text-button" data-action="sync-page">同步本页</button>`}<button class="text-button" data-action="library">管理账号与连接 ${icon("arrow")}</button></div></section>`;
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
        )}</div><button class="page-link" data-action="notes"><span>${icon("note")}本页评注</span><span>${state.notes.length}${icon("arrow")}</span></button><div class="copy-region"><button class="btn primary copy-main" data-action="copy" ${state.copying ? "disabled" : ""}>${icon("copy")}${state.copying ? "正在准备…" : "复制本页评注"}</button>${state.pageError ? `<p class="inline-error" role="alert">${esc(state.pageError)}<button class="text-button" data-action="sync-page">重试</button></p>` : ""}</div><footer class="menu-footer"><button data-action="library">${icon("history")}历史记录</button><button class="icon-btn" data-action="markers" aria-label="${state.showMarkers ? "隐藏" : "显示"}页面标记" aria-pressed="${state.showMarkers}">${icon("eye")}</button></footer></section>`;
    else if (state.panel === "settings") html = connectionMarkup();
    else if (state.panel === "editor" && d)
      html = `<section class="panel editor popover v4-composer" role="dialog" aria-label="添加评注" aria-busy="${state.busy}"><header class="popover-head"><span>${esc(d.note.label || "评注")}</span><button class="icon-btn" data-action="cancel-draft" aria-label="取消评注">${icon("close")}</button></header>${d.note.id ? "" : draftMedia(d)}<textarea id="review-comment" aria-label="评注内容" placeholder="添加评注…" maxlength="12000">${esc(d.note.comment)}</textarea>${d.error && d.asset ? `<p class="inline-error" role="alert">${esc(d.error)}</p>` : ""}<footer class="composer-bottom"><div class="feedback-actions">${["positive", "negative"].map((v) => `<button class="feedback-button" data-action="feedback" data-feedback="${v}" aria-label="${v === "positive" ? "点赞" : "点踩"}" aria-pressed="${d.note.feedback === v}">${icon(v === "positive" ? "like" : "dislike")}</button>`).join("")}</div><button class="btn primary composer-submit" data-action="save">保存</button></footer></section>`;
    else if (state.panel === "notes")
      html = `<div class="drawer-backdrop" data-action="minimize"></div><aside class="panel drawer notes-panel" role="dialog" aria-modal="true" aria-label="本页评注"><header class="drawer-head"><h2>本页评注</h2><button class="icon-btn" data-action="minimize" aria-label="关闭本页评注">${icon("close")}</button></header><div class="drawer-content">${state.pageError ? `<p class="inline-error" role="alert">${esc(state.pageError)}</p>` : ""}${state.notes.length ? state.notes.map((n, i) => `<article class="drawer-note"><div class="saved-head"><span>${feedbackMarkup(n)}${esc(n.label)}</span><time>${date(n.createdAt)}</time></div><p>${esc(n.comment)}</p><div class="drawer-note-actions"><button data-action="peek" data-id="${n.id}">${n.hasVideo ? "播放录制" : n.hasImage ? "查看截图" : "查看评注"}</button><button data-action="edit" data-id="${n.id}">修改</button><button data-action="locate" data-id="${n.id}">定位</button><button data-action="delete" data-id="${n.id}">删除</button></div></article>`).join("") : '<div class="empty-state">本页还没有评注</div>'}</div><footer class="drawer-footer"><span>${state.notes.length} 条</span><button class="btn primary" data-action="copy">复制本页评注</button></footer></aside>`;
    else if (state.panel === "peek" && state.peek) {
      const n = state.notes.find((n) => n.id === state.peek.id),
        a = state.peek.asset;
      if (n)
        html = `<div class="drawer-backdrop" data-action="close-peek"></div><aside class="panel drawer notes-panel" role="dialog" aria-modal="true" aria-label="评注详情"><header class="drawer-head"><h2>评注详情</h2><button class="icon-btn" data-action="close-peek" aria-label="关闭详情">${icon("close")}</button></header><div class="drawer-content"><div class="saved-head"><a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">${esc(new URL(n.url).hostname)}</a><time>${date(n.createdAt)}</time></div>${feedbackMarkup(n)}<p class="detail-comment">${esc(n.comment)}</p><div class="drawer-note-actions"><button data-action="edit" data-id="${n.id}">修改</button><button data-action="delete" data-id="${n.id}">删除</button></div>${a?.video ? `<video class="saved-video" src="${a.video}" poster="${a.viewport}" controls muted playsinline></video>${a.frames?.length ? `<div class="keyframes">${a.frames.map((f, i) => `<button data-action="seek-frame" data-index="${i}" aria-label="跳转 ${clock(f.at)}"><img src="${f.data}" alt=""><time>${clock(f.at)}</time></button>`).join("")}</div>` : ""}` : a?.viewport ? `<button class="image-preview" data-action="expand-media" aria-label="放大截图"><img src="${a.viewport}" alt="截图"></button>` : ""}</div></aside>`;
    } else if (state.panel === "media") {
      const a = state.draft?.asset || state.peek?.asset;
      html = `<div class="drawer-backdrop" data-action="close-media"></div><section class="panel media-view" role="dialog" aria-modal="true" aria-label="截图">${panelHead("截图")}<button class="icon-btn media-close" data-action="close-media" aria-label="关闭截图">${icon("close")}</button><img src="${a?.viewport || ""}" alt="截图"></section>`;
    } else if (state.panel === "record" && state.record) {
      const r = state.record;
      html = `<section class="panel recording-control" role="dialog" aria-label="区域录制"><span>${r.phase === "recording" ? '<i class="record-dot"></i> 录制中' : r.phase === "waiting" ? "点击工具栏图标以允许录制" : r.phase === "starting" ? "正在启动…" : r.phase === "stopping" ? "正在处理…" : "区域录制"}</span>${r.phase === "recording" ? '<button class="btn primary small" data-action="stop-record">停止</button>' : ["ready", "failed"].includes(r.phase) ? '<button class="btn small" data-action="reselect-record">重选</button><button class="btn primary small" data-action="start-record">' + (r.phase === "failed" ? "重试" : "开始") + "</button>" : ""}<button class="icon-btn" data-action="cancel-record" aria-label="取消录制">${icon("close")}</button>${r.error ? `<p class="inline-error" role="alert">${esc(r.error)}</p>` : ""}</section>`;
    } else if (state.panel === "confirm") {
      const deleting = state.confirm?.kind === "delete";
      html = `<section class="panel confirm-panel" role="dialog" aria-modal="true" aria-label="${deleting ? "删除评注" : "放弃评注"}"><div class="confirm-body"><h3>${deleting ? "删除这条评注？" : "放弃未保存的评注？"}</h3><div class="confirm-row"><button class="btn" data-action="${deleting ? "close-peek" : "confirm-cancel"}">保留</button><button class="btn danger" data-action="${deleting ? "confirm-delete" : "confirm-discard"}">${deleting ? "删除" : "放弃"}</button></div></div></section>`;
    } else if (state.panel === "copy-fallback")
      html = `<section class="panel setup-panel" role="dialog" aria-label="手动复制">${panelHead("手动复制")}<div class="setup-body"><textarea id="manual-copy" readonly aria-label="评注提示词">${esc(state.copyText)}</textarea></div></section>`;
    else if (state.panel === "confirm-close")
      html = `<section class="panel confirm-panel" role="dialog" aria-label="未保存评注"><div class="confirm-body"><h3>这条评注尚未保存</h3><button class="btn" data-action="resume-draft">继续编辑</button><button class="btn danger" data-action="discard-disable">放弃并关闭</button></div></section>`;
    shadow.getElementById("panel").innerHTML = html;
    updateComposer();
    positionWidget();
    shadow
      .querySelectorAll("img,video")
      .forEach((el) =>
        el.addEventListener(
          el.tagName === "VIDEO" ? "loadedmetadata" : "load",
          positionWidget,
          { once: true },
        ),
      );
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
      const c = shadow.querySelector(".recording-control"),
        pos = PageReviewMedia.controls(r, state.record.viewport, {
          width: Math.min(310, innerWidth - 24),
          height: c?.getBoundingClientRect().height || 48,
        });
      if (c && pos)
        Object.assign(c.style, { left: pos.left + "px", top: pos.top + "px" });
    } else shadow.querySelector(".record-boundary")?.remove();
    const rect = currentAnchor();
    if (rect) highlight(rect, d?.note.type === "region" ? 0 : 5);
    else if (state.mode === "browse") highlight(null);
    if (focus && state.panel === "editor") {
      const input = shadow.getElementById("review-comment");
      input?.focus({ preventScroll: true });
      input?.setSelectionRange(input.value.length, input.value.length);
    }
    if (state.panel === "copy-fallback") {
      const input = shadow.getElementById("manual-copy");
      input.focus();
      input.select();
    }
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
  async function collapse() {
    if (state.draft) {
      state.panel = "editor";
      renderPanel(true);
      return;
    }
    state.panel = null;
    state.mode = "browse";
    state.hover = null;
    state.rebind = null;
    highlight(null);
    state.dock = { side: "right", bottom: 24 };
    renderWidget();
    renderPanel();
    renderMarkers();
    await send("SAVE_DOCK", { dock: state.dock });
  }
  function enter(mode) {
    if (state.draft) {
      state.panel = "editor";
      renderPanel(true);
      toast("先保存或取消当前评注");
      return;
    }
    state.mode = mode;
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
    state.mode = "browse";
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
    draft.note.comment =
      shadow.getElementById("review-comment")?.value ?? draft.note.comment;
    draft.allowWithoutImage =
      shadow.getElementById("allow-text")?.checked ||
      draft.allowWithoutImage ||
      false;
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
      state.mode = keepSelecting ? "point" : "browse";
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
    const asset = await send("GET_ASSET", { id });
    state.peek = { id, asset };
    state.panel = "peek";
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
  async function action(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const name = button.dataset.action;
    if (name === "toggle" && performance.now() < suppressClick) return;
    if (state.busy) return;
    try {
      switch (name) {
        case "toggle":
          if (!state.panel) await refreshPageState();
          state.panel = state.panel ? null : state.draft ? "editor" : "menu";
          renderPanel(Boolean(state.draft));
          renderWidget();
          break;
        case "minimize":
          await collapse();
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
          enter("record-area");
          break;
        case "seek-frame": {
          const a =
              state.panel === "peek" ? state.peek?.asset : state.draft?.asset,
            f = a?.frames?.[Number(button.dataset.index)],
            video = shadow.querySelector("video");
          if (f && video) {
            video.currentTime = f.at;
            await video.play();
          }
          break;
        }
        case "settings":
          state.cloud = await send("CLOUD_SETUP");
          state.panel = "settings";
          renderPanel();
          break;
        case "login":
          await send("CLOUD_LOGIN");
          state.cloud = await send("CLOUD_SETUP");
          state.panel = "settings";
          renderPanel();
          break;
        case "check-connection":
          state.cloud = await send("CLOUD_SETUP");
          renderPanel();
          toast(
            state.cloud.cliConnections?.length
              ? "终端已连接"
              : "尚未收到终端连接",
          );
          break;
        case "sync-page":
          await send("SYNC_PAGE");
          await refreshPageState();
          renderPanel();
          toast("本页同步已完成");
          break;
        case "copy-install":
          await clipboard(
            "curl -fsSL " + state.cloud.capabilities.installUrl + " | sh",
          );
          toast("已复制安装命令");
          break;
        case "copy-login":
          await clipboard("page-review login --api " + state.cloud.apiUrl);
          toast("已复制登录命令");
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
          state.mode = "record-area";
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
          state.confirm = { kind: "delete", id: button.dataset.id };
          state.panel = "confirm";
          renderPanel();
          break;
        case "confirm-delete":
          await send("DELETE", { id: state.confirm.id });
          state.confirm = null;
          state.panel = "notes";
          await loadNotes();
          renderPanel();
          toast("已删除");
          break;
        case "page":
          if (state.draft) {
            state.panel = "editor";
            renderPanel(true);
          } else await begin("page", null, null);
          break;
        case "finish":
          state.mode = "browse";
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
          state.mode = "browse";
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
              state.draft.note.feedback === button.dataset.feedback
                ? null
                : button.dataset.feedback;
            updateComposer();
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
          await peek(button.dataset.id);
          break;
        case "locate":
          locate(button.dataset.id);
          break;
        case "edit": {
          const note = state.notes.find((n) => n.id === button.dataset.id);
          if (!note) break;
          const match = state.matches.get(note.id);
          state.draft = {
            note: { ...note },
            asset: await send("GET_ASSET", { id: note.id }),
            target: match?.element || null,
            rect: match?.status === "found" ? markRect(note, match) : null,
          };
          state.panel = "editor";
          renderPanel(true);
          break;
        }
        case "rebind":
          state.rebind = button.dataset.id;
          enter("point");
          break;
      }
    } catch (error) {
      toast(error.message);
    }
  }
  function orbDown(event) {
    const orb = event.target.closest(".orb");
    if (!orb || event.button !== 0 || state.busy) return;
    const r = orb.getBoundingClientRect();
    drag = {
      x: r.left,
      y: r.top,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      el: orb,
    };
    orb.setPointerCapture(event.pointerId);
  }
  function pointerDown(event) {
    if (
      own(event) ||
      !["area", "record-area"].includes(state.mode) ||
      event.button !== 0 ||
      state.draft ||
      state.busy
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    regionDrag = { x: event.clientX, y: event.clientY };
    document.documentElement.setPointerCapture?.(event.pointerId);
  }
  function pointerMove(event) {
    if (drag) {
      const dx = event.clientX - drag.startX,
        dy = event.clientY - drag.startY;
      if (Math.hypot(dx, dy) < 5 && !drag.moved) return;
      drag.moved = true;
      drag.el.classList.add("is-dragging");
      drag.el.setAttribute("aria-expanded", "false");
      state.panel = null;
      shadow.getElementById("panel").replaceChildren();
      positionWidget({ x: drag.x + dx, y: drag.y + dy });
      return;
    }
    if (regionDrag) {
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
  function cancelPointer() {
    drag?.el.classList.remove("is-dragging");
    drag = null;
    regionDrag = null;
    highlight(null);
    positionWidget();
  }
  function pointerUp(event) {
    if (drag) {
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
    if (!regionDrag) return;
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
    if (own(event)) return;
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
      state.mode = "browse";
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
        state.mode = "browse";
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
      state.mode = "browse";
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
  async function copyPage() {
    if (state.copying) return;
    if (state.draft || state.record) {
      toast("请先保存当前评注");
      return;
    }
    state.copying = true;
    renderPanel();
    try {
      const fixed = await send("CREATE_HANDOFF");
      state.copyText = fixed.text;
      try {
        await clipboard(fixed.text);
        toast("已复制 " + fixed.count + " 条评注，粘贴到终端使用");
      } catch {
        state.panel = "copy-fallback";
      }
    } catch (e) {
      state.cloud = await send("CLOUD_SETUP").catch(() => null);
      if (!state.cloud?.configured || !state.cloud.cliConnections?.length)
        state.panel = "settings";
      toast(e.message);
      state.pageError = e.message;
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
    state.mode = "browse";
    renderPanel();
    renderWidget();
  }
  function prepareRecording(target, rect, region) {
    try {
      PageReviewMedia.region(rect, viewport());
      if (
        !PageReviewMedia.controls(rect, viewport(), { width: 310, height: 48 })
      )
        throw Error("请缩小选区，为录制按钮留出空间");
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
      state.mode = "browse";
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
    state.mode = "browse";
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
